/**
 * Generates the API contract and the frontend API reference from the route sources:
 *
 * - docs/api/openapi.json: OpenAPI 3.1 with the exact request body and query schemas, summaries
 *   and the permission codes each handler checks (for client generation).
 * - docs/frontend/api-reference.md: the same information as readable field tables.
 *
 * It loads the route modules and reads their sources; no database connection is opened.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { OperationContext, OperationDetails } from '../shared/http/openapi.js';
import {
  analyzeRoutes,
  describeTarget,
  evaluate,
  routeFiles,
  scopeOf,
  type CodeKind,
  type RequestPart,
  type RouteFacts,
} from './api-docs/analyze.js';
import { example, fieldRows, table, typeLabel, type JsonSchema } from './api-docs/render.js';

process.env.LOG_LEVEL ??= 'silent';
const { ROUTE_GROUPS } = await import('../routes/index.js');
const { webhookRouter } = await import('../modules/billing/billing.routes.js');
const { buildOpenApi } = await import('../shared/http/openapi.js');
const { PERMISSIONS } = await import('../modules/admin/auth/roles/permission.constants.js');
const { ORG_PERMISSIONS } = await import('../modules/access/access.constants.js');

const root = resolve('src');
const PATIENT_ACTIONS = [
  'profile.read',
  'profile.update',
  'registration.create',
  'medical.read',
  'medical.upload',
  'medical.export',
  'consent.manage',
];
const literalKinds = new Map<string, CodeKind>();
for (const code of Object.values(PERMISSIONS)) literalKinds.set(code, 'platform');
for (const code of ORG_PERMISSIONS) literalKinds.set(code, 'organization');
for (const code of PATIENT_ACTIONS) literalKinds.set(code, 'patient');
const platformKeys = PERMISSIONS as unknown as Record<string, string>;

// ── Analyze route sources and map routers to their source declarations ─────────

interface Described {
  facts: RouteFacts;
  schemas: Partial<Record<RequestPart, JsonSchema>>;
  pathParams: Record<string, JsonSchema>;
  sources: Partial<Record<RequestPart, string>>;
  summary?: string;
  description?: string;
  codes: Map<string, CodeKind>;
  returnsCommand: boolean;
}

const isRouter = (value: unknown) =>
  typeof value === 'function' && Array.isArray((value as { stack?: unknown }).stack);
const routerSource = new Map<unknown, { file: string; name: string }>();
const facts: RouteFacts[] = [];
for (const file of routeFiles(root)) {
  facts.push(...(await analyzeRoutes(file)));
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const scope = scopeOf(file);
  for (const [exported, value] of Object.entries(mod))
    if (isRouter(value) && !routerSource.has(value))
      routerSource.set(value, {
        file,
        name: exported === 'default' ? (scope.defaultExport ?? 'router') : exported,
      });
}

function toJsonSchema(schema: unknown): JsonSchema {
  const json = z.toJSONSchema(schema as z.ZodType, {
    io: 'input',
    unrepresentable: 'any',
    reused: 'inline',
  }) as JsonSchema & { $schema?: string };
  delete json.$schema;
  return json;
}

const humanize = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .toLowerCase()
    .replace(/^./u, (first) => first.toUpperCase());

const described = new Map<RouteFacts, Described>();
async function describeFacts(route: RouteFacts): Promise<Described> {
  const done = described.get(route);
  if (done) return done;
  const result: Described = {
    facts: route,
    schemas: {},
    pathParams: {},
    sources: {},
    codes: new Map(),
    returnsCommand: false,
  };
  for (const [part, ref] of Object.entries(route.schemas) as Array<
    [RequestPart, NonNullable<RouteFacts['schemas'][RequestPart]>]
  >) {
    try {
      result.schemas[part] = toJsonSchema(await evaluate(ref.scope, ref.node));
    } catch {
      result.sources[part] = ref.scope.text(ref.node);
    }
  }
  for (const [name, ref] of Object.entries(route.pathParams))
    try {
      result.pathParams[name] = toJsonSchema(await evaluate(ref.scope, ref.node));
    } catch {
      // Undocumented path parameter schemas fall back to a plain string.
    }
  for (const key of route.platformPermissionKeys)
    if (platformKeys[key]) result.codes.set(platformKeys[key], 'platform');
  // The first target in source order is the function whose result the handler returns.
  route.targets.forEach((target, index) => {
    const info = describeTarget(target, literalKinds, platformKeys);
    for (const [code, kind] of info.codes) result.codes.set(code, kind);
    if (index === 0) {
      result.summary = humanize(target.name);
      result.description = info.summary;
      result.returnsCommand = info.returnsCommand;
    }
  });
  described.set(route, result);
  return result;
}

// Evaluate every route up front: `describe` below is synchronous.
for (const route of facts) await describeFacts(route);

const byOperation = new Map<string, Described>();
function describe(operation: OperationContext): OperationDetails | undefined {
  // Match against the outermost router whose source is known (sub-routers are often unexported).
  let route: RouteFacts | undefined;
  for (const { router, prefix } of operation.routers) {
    const source = routerSource.get(router);
    if (!source) continue;
    const relative = operation.expressPath.slice(prefix.length).replace(/(.)\/$/u, '$1') || '/';
    route = facts.find(
      (candidate) =>
        candidate.file === source.file &&
        candidate.rootRouter === source.name &&
        candidate.method === operation.method &&
        (candidate.rootPattern.test(relative) || candidate.rootPattern.test(`${relative}/`)),
    );
    if (route) break;
  }
  if (!route) return undefined;
  const info = described.get(route)!;
  byOperation.set(`${operation.method} ${operation.path}`, info);
  return {
    summary: info.summary,
    description: info.description,
    body: info.schemas.body,
    bodyContentType: route.uploadField ? 'multipart/form-data' : undefined,
    query: info.schemas.query,
    pathParams: info.pathParams as Record<string, Record<string, unknown>>,
    idempotent: route.idempotent,
    permissions: [...info.codes.keys()],
  };
}

const spec = buildOpenApi(ROUTE_GROUPS, {
  version: process.env.npm_package_version ?? '1.0.0',
  extra: [{ tag: 'Payment webhooks', prefix: '/webhooks', router: webhookRouter }],
  describe,
});

// ── Markdown reference ─────────────────────────────────────────────────────

type SpecOperation = {
  tags: string[];
  summary?: string;
  security: unknown[];
  parameters?: Array<{ name?: string; in?: string; $ref?: string }>;
};
const byTag = new Map<string, Array<{ method: string; path: string; op: SpecOperation }>>();
for (const [path, methods] of Object.entries(spec.paths))
  for (const [method, op] of Object.entries(methods as Record<string, SpecOperation>)) {
    const tag = op.tags[0]!;
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag)!.push({ method, path, op });
  }

const anchor = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9 -]/gu, '')
    .trim()
    .replace(/ /gu, '-');
const kindLabel: Record<CodeKind, string> = {
  organization: 'org',
  platform: 'platform',
  patient: 'patient authority',
};

const lines: string[] = [
  '# DocDuniya API reference',
  '',
  '<!-- Generated by `npm run openapi` from the route sources. Do not edit by hand. -->',
  '',
  'Every operation the backend serves, with the exact request fields it validates. Read the [frontend integration guide](README.md) first: it explains sign-in, headers, errors, pagination, roles and the screen-by-screen workflows that use these endpoints.',
  '',
  '- Base URL: `<API host>/api/v1`. Paths below are relative to it.',
  '- **Auth:** *Public* needs no session; *Signed in* needs the access cookie or `Authorization: Bearer <accessToken>`.',
  '- **Idempotency-Key:** commands marked *required* need a fresh UUID per user action (reuse it only when retrying the same request).',
  '- **Permissions in code path** lists the permission codes found in the handler’s service code. *org* codes come from the caller’s roles in that organization (`GET /me/workspaces`), *platform* codes from the platform admin role (`GET /auth/me`), *patient authority* from owning the patient profile or being its reviewed representative. The list is extracted automatically: a route needs the code that matches the caller and action (for example check-in needs `appointments.manage`, starting a visit `clinical.write`), and some codes are checked on other people (a doctor’s own affiliation). Use it to decide which screens to show; always handle `403` and `404` as well.',
  '- Request bodies are strict: unknown fields are rejected with `400 VALIDATION_ERROR`. Fields marked *yes* are required. "Minimal example" bodies contain the required fields only, with placeholder values.',
  '- Every success response is `{ "success": true, "data": … }`; commands return `data: { "id", "version" }` unless noted.',
  '',
  `Operations: ${[...byTag.values()].reduce((sum, list) => sum + list.length, 0)}.`,
  '',
  '## Contents',
  '',
  ...[...byTag.entries()].map(([tag, list]) => `- [${tag}](#${anchor(tag)}) (${list.length})`),
  '- [Appendix: statuses and enumerations](#appendix-statuses-and-enumerations)',
  '',
];

for (const [tag, list] of byTag) {
  lines.push(`## ${tag}`, '');
  for (const { method, path, op } of list) {
    const info = byOperation.get(`${method} ${path}`);
    lines.push(`### \`${method.toUpperCase()} ${path}\``, '');
    if (op.summary) lines.push(`${op.summary}.`, '');
    if (info?.description) lines.push(`> ${info.description}`, '');
    const idempotent = op.parameters?.some((p) => p.$ref?.endsWith('/IdempotencyKey'));
    const facts = [
      `**Auth:** ${op.security.length ? 'Signed in' : 'Public'}`,
      ...(idempotent ? ['**Idempotency-Key:** required'] : []),
    ];
    if (info?.codes.size)
      facts.push(
        `**Permissions in code path:** ${[...info.codes]
          .map(([code, kind]) => `\`${code}\` (${kindLabel[kind]})`)
          .join(', ')}`,
      );
    lines.push(facts.join(' · '), '');
    const pathParams = (op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name!);
    if (pathParams.length)
      lines.push(
        `**Path:** ${pathParams
          .map((name) => {
            const schema = info?.pathParams[name];
            return schema ? `\`${name}\` (${typeLabel(schema)})` : `\`${name}\``;
          })
          .join(', ')}`,
        '',
      );
    const query = info?.schemas.query;
    if (query) {
      const rows = fieldRows(query);
      if (rows.length) lines.push('**Query parameters**', '', table(rows), '');
    } else if (info?.sources.query)
      lines.push(
        '**Query parameters** (schema source)',
        '',
        '```ts',
        info.sources.query,
        '```',
        '',
      );
    const body = info?.schemas.body;
    if (body) {
      const multipart = Boolean(info?.facts.uploadField);
      lines.push(
        multipart
          ? `**Body** (\`multipart/form-data\`; file field \`${info!.facts.uploadField}\` plus these fields)`
          : '**Body** (`application/json`)',
        '',
      );
      const rows = fieldRows(body);
      lines.push(rows.length ? table(rows) : '*Empty object `{}`.*', '');
      if (!multipart && rows.length)
        lines.push(
          '<details><summary>Minimal example</summary>',
          '',
          '```json',
          JSON.stringify(example(body), null, 2),
          '```',
          '',
          '</details>',
          '',
        );
    } else if (info?.sources.body)
      lines.push('**Body** (schema source)', '', '```ts', info.sources.body, '```', '');
    else if (info?.facts.uploadField)
      lines.push(
        `**Body:** \`multipart/form-data\` with the file in field \`${info.facts.uploadField}\`.`,
        '',
      );
    else if (['post', 'put', 'patch'].includes(method))
      lines.push('**Body:** none (send no body or `{}`).', '');
    if (info?.returnsCommand)
      lines.push('**Returns:** `{ id, version }` of the affected record.', '');
  }
}

// ── Appendix: lifecycle and category values stored on records (from the Mongoose models) ──

type SchemaPath = {
  enumValues?: string[];
  caster?: { enumValues?: string[] };
  schema?: { eachPath: (fn: (path: string, type: SchemaPath) => void) => void };
};
const ENUM_FIELD =
  /(status|state|outcome|phase|decision|urgency|priority|severity|mode|kind|policy|use)$/iu;
const { default: mongoose } = await import('mongoose');
const enumRows: string[] = [];
for (const name of mongoose.modelNames().sort()) {
  const model = mongoose.model(name);
  const seen = new Set<string>();
  const visit = (schema: NonNullable<SchemaPath['schema']>, prefix: string, depth: number) =>
    schema.eachPath((path, type) => {
      const field = `${prefix}${path}`;
      const values = type.enumValues?.length ? type.enumValues : type.caster?.enumValues;
      // Provenance (who acted: a user or a service) is audit metadata, not a UI value.
      const metadata = values?.join() === 'USER,SERVICE';
      if (values?.length && ENUM_FIELD.test(path) && !metadata && !seen.has(field)) {
        seen.add(field);
        enumRows.push(
          `| ${name} (\`${model.collection.collectionName}\`) | \`${field}\` | ${values.map((value) => `\`${value}\``).join(', ')} |`,
        );
      }
      if (type.schema && depth < 3) visit(type.schema, `${field}.`, depth + 1);
    });
  visit(model.schema as unknown as NonNullable<SchemaPath['schema']>, '', 0);
}
lines.push(
  '## Appendix: statuses and enumerations',
  '',
  'Values stored on records and returned in responses (for badges, filters and dropdowns), read from the database models. Lifecycles move only through the commands documented above.',
  '',
  '| Record (collection) | Field | Values |',
  '| --- | --- | --- |',
  ...enumRows,
  '',
);

const specTarget = resolve('docs/api/openapi.json');
const docsTarget = resolve('docs/frontend/api-reference.md');
for (const target of [specTarget, docsTarget]) mkdirSync(dirname(target), { recursive: true });
writeFileSync(specTarget, `${JSON.stringify(spec, null, 2)}\n`);
writeFileSync(docsTarget, `${lines.join('\n').replace(/\n{3,}/gu, '\n\n')}\n`);

const operations = [...byTag.values()].flat();
const withBody = operations.filter(({ method }) => ['post', 'put', 'patch'].includes(method));
const missing = withBody.filter(({ method, path }) => {
  const info = byOperation.get(`${method} ${path}`);
  return !info?.schemas.body && !info?.sources.body && !info?.facts.uploadField;
});
// eslint-disable-next-line no-console -- command-line output
console.log(
  [
    `Wrote ${Object.keys(spec.paths).length} paths (${operations.length} operations) to ${relative(process.cwd(), specTarget)}`,
    `Wrote ${relative(process.cwd(), docsTarget)}`,
    `Unmatched operations: ${operations.filter(({ method, path }) => !byOperation.has(`${method} ${path}`)).length}`,
    `Mutations without a detected body schema: ${missing.length}`,
    ...missing.map(({ method, path }) => `  ${method.toUpperCase()} ${path}`),
  ].join('\n'),
);
