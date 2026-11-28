import { optionalAuth, protect } from '../../modules/admin/auth/auth.middleware.js';

/**
 * Machine-readable OpenAPI 3.1 contract generated from the mounted Express routers. Operations,
 * path parameters, authentication and idempotency requirements are derived from the routes
 * themselves. At runtime request bodies are documented as JSON objects; `npm run openapi` passes
 * `describe` to add the exact request schemas, summaries and permission codes from the sources.
 */
type Handler = { handle?: unknown };
type Layer = {
  route?: { path: string; methods: Record<string, boolean>; stack: Handler[] };
  handle?: unknown;
  rawPath?: string;
};
type RouterLike = { stack: Layer[] };

const MUTATING = new Set(['post', 'put', 'patch', 'delete']);
/** Mutations that are not idempotent commands (sign-in flows, webhooks, public queries). */
const NO_IDEMPOTENCY_PREFIXES = ['/auth', '/discovery/route', '/webhooks', '/health'];

const toOpenApiPath = (path: string) => path.replace(/:([A-Za-z0-9_]+)/gu, '{$1}');
const isRouter = (value: unknown): value is RouterLike =>
  typeof value === 'function' && Array.isArray((value as unknown as RouterLike).stack);

interface Operation {
  method: string;
  path: string;
  tag: string;
  secured: boolean;
  /** The router that registered the route and the path it was registered with. */
  router: RouterLike;
  localPath: string;
  /** Routers from the group's router down to `router`, with the path each is mounted at. */
  routers: Array<{ router: unknown; prefix: string }>;
}

/** Context passed to `describe`, which can enrich an operation with documentation. */
export interface OperationContext {
  method: string;
  path: string;
  localPath: string;
  router: unknown;
  /** Express-style full path (`:param`), and the routers it passes through. */
  expressPath: string;
  routers: Array<{ router: unknown; prefix: string }>;
  tag: string;
  secured: boolean;
}

export interface OperationDetails {
  summary?: string;
  description?: string;
  /** JSON Schema of the request body. */
  body?: Record<string, unknown>;
  bodyContentType?: string;
  /** JSON Schema (an object) of the query string; each property becomes a query parameter. */
  query?: Record<string, unknown>;
  /** Whether the operation requires an `Idempotency-Key` header (overrides the default rule). */
  idempotent?: boolean;
  /** JSON Schemas of individual path parameters, by name. */
  pathParams?: Record<string, Record<string, unknown>>;
  /** Permission codes the handler checks. */
  permissions?: string[];
}

function collect(
  router: RouterLike,
  prefix: string,
  tag: string,
  inheritedAuth: boolean,
  out: Operation[],
  parents: Array<{ router: unknown; prefix: string }> = [],
) {
  const routers = [...parents, { router, prefix }];
  let secured = inheritedAuth;
  const securedMounts = new Set<string>();
  for (const layer of router.stack) {
    if (layer.route) {
      const routeAuth = secured || layer.route.stack.some((handler) => handler.handle === protect);
      for (const method of Object.keys(layer.route.methods))
        out.push({
          method,
          path: `${prefix}${layer.route.path}`,
          tag,
          secured: routeAuth,
          router,
          localPath: layer.route.path,
          routers,
        });
      continue;
    }
    const mountPath = layer.rawPath && layer.rawPath !== '/' ? layer.rawPath : '';
    // `use(protect)` secures every later route; `use('/x', protect, router)` only that path.
    if (layer.handle === protect) {
      if (mountPath) securedMounts.add(mountPath);
      else secured = true;
    } else if (layer.handle === optionalAuth) continue;
    else if (isRouter(layer.handle))
      collect(
        layer.handle,
        `${prefix}${mountPath}`,
        tag,
        secured || securedMounts.has(mountPath),
        out,
        routers,
      );
  }
}

const errorResponse = {
  description: 'Error envelope',
  content: {
    'application/json': { schema: { $ref: '#/components/schemas/Error' } },
  },
};

export function buildOpenApi(
  groups: Array<{ tag: string; prefix?: string; router: unknown }>,
  options: {
    version: string;
    serverUrl?: string;
    extra?: Array<{ tag: string; prefix: string; router: unknown }>;
    /** Optional enrichment (summaries, request schemas, permissions) by the docs generator. */
    describe?: (operation: OperationContext) => OperationDetails | undefined;
  },
) {
  const operations: Operation[] = [];
  for (const group of [...groups, ...(options.extra ?? [])])
    collect(group.router as RouterLike, group.prefix ?? '', group.tag, false, operations);
  const paths: Record<string, Record<string, unknown>> = {};
  const seen = new Set<string>();
  for (const operation of operations) {
    const path = toOpenApiPath(
      operation.path === '' ? '/' : operation.path.replace(/\/$/u, '') || '/',
    );
    const id = `${operation.method} ${path}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const details = options.describe?.({
      method: operation.method,
      path,
      localPath: operation.localPath,
      router: operation.router,
      expressPath: operation.path,
      routers: operation.routers,
      tag: operation.tag,
      secured: operation.secured,
    });
    const parameters: unknown[] = [...path.matchAll(/\{([A-Za-z0-9_]+)\}/gu)].map((match) => ({
      name: match[1],
      in: 'path',
      required: true,
      schema:
        details?.pathParams?.[match[1]!] ??
        (match[1]!.endsWith('Id') ? { $ref: '#/components/schemas/ObjectId' } : { type: 'string' }),
    }));
    const mutating = MUTATING.has(operation.method);
    const idempotent =
      details?.idempotent ??
      (mutating &&
        operation.secured &&
        !NO_IDEMPOTENCY_PREFIXES.some((prefix) => path.startsWith(prefix)));
    if (idempotent) parameters.push({ $ref: '#/components/parameters/IdempotencyKey' });
    const query = details?.query as
      { properties?: Record<string, unknown>; required?: string[] } | undefined;
    for (const [name, schema] of Object.entries(query?.properties ?? {}))
      parameters.push({
        name,
        in: 'query',
        required: query?.required?.includes(name) ?? false,
        schema,
      });
    paths[path] ??= {};
    paths[path]![operation.method] = {
      tags: [operation.tag],
      ...(details?.summary ? { summary: details.summary } : {}),
      ...(details?.description ? { description: details.description } : {}),
      ...(details?.permissions?.length ? { 'x-permissions': details.permissions } : {}),
      operationId: `${operation.method}${path
        .replace(/\{([^}]+)\}/gu, 'By_$1')
        .split(/[^A-Za-z0-9]+/u)
        .filter(Boolean)
        .map((part) => part[0]!.toUpperCase() + part.slice(1))
        .join('')}`,
      ...(operation.secured
        ? { security: [{ bearerAuth: [] }, { cookieAuth: [] }] }
        : { security: [] }),
      ...(parameters.length ? { parameters } : {}),
      ...(details?.body
        ? {
            requestBody: {
              required: true,
              content: {
                [details.bodyContentType ?? 'application/json']: { schema: details.body },
              },
            },
          }
        : mutating && operation.method !== 'delete'
          ? {
              requestBody: {
                required: false,
                content: { 'application/json': { schema: { type: 'object' } } },
              },
            }
          : {}),
      responses: {
        [operation.method === 'post' ? '201' : '200']: {
          description: 'Success envelope',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } },
        },
        ...(operation.method === 'post'
          ? { '200': { description: 'Success envelope (replay or action)' } }
          : {}),
        '400': errorResponse,
        ...(operation.secured ? { '401': errorResponse, '403': errorResponse } : {}),
        '404': errorResponse,
        ...(mutating ? { '409': errorResponse } : {}),
        '429': errorResponse,
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'DocDuniya API',
      version: options.version,
      description:
        'Healthcare marketplace and provider platform. All routes are under /api/v1. Commands require an Idempotency-Key; mutations use optimistic expectedVersion where documented.',
    },
    servers: [{ url: options.serverUrl ?? '/api/v1' }],
    tags: [...new Set(operations.map((operation) => operation.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'accessToken' },
      },
      parameters: {
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          description: 'Unique per logical command (UUID). Replays return the original result.',
          schema: { type: 'string', minLength: 8, maxLength: 200 },
        },
      },
      schemas: {
        ObjectId: { type: 'string', pattern: '^[a-f0-9]{24}$' },
        Success: {
          type: 'object',
          required: ['success'],
          properties: { success: { const: true }, data: {}, message: { type: 'string' } },
        },
        Error: {
          type: 'object',
          required: ['success', 'code', 'message'],
          properties: {
            success: { const: false },
            code: { type: 'string' },
            message: { type: 'string' },
            details: {},
          },
        },
      },
    },
  };
}
