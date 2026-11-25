import { optionalAuth, protect } from '../../modules/admin/auth/auth.middleware.js';

/**
 * Machine-readable OpenAPI 3.1 contract generated from the mounted Express routers. Operations,
 * path parameters, authentication and idempotency requirements are derived from the routes
 * themselves; request bodies are validated server-side by strict schemas and documented as
 * JSON objects with the shared error envelope.
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
}

function collect(
  router: RouterLike,
  prefix: string,
  tag: string,
  inheritedAuth: boolean,
  out: Operation[],
) {
  let secured = inheritedAuth;
  for (const layer of router.stack) {
    if (layer.route) {
      const routeAuth = secured || layer.route.stack.some((handler) => handler.handle === protect);
      for (const method of Object.keys(layer.route.methods))
        out.push({ method, path: `${prefix}${layer.route.path}`, tag, secured: routeAuth });
      continue;
    }
    if (layer.handle === protect) secured = true;
    else if (layer.handle === optionalAuth) continue;
    else if (isRouter(layer.handle))
      collect(layer.handle, `${prefix}${layer.rawPath ?? ''}`, tag, secured, out);
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
    const parameters: unknown[] = [...path.matchAll(/\{([A-Za-z0-9_]+)\}/gu)].map((match) => ({
      name: match[1],
      in: 'path',
      required: true,
      schema: match[1]!.endsWith('Id')
        ? { $ref: '#/components/schemas/ObjectId' }
        : { type: 'string' },
    }));
    const mutating = MUTATING.has(operation.method);
    const idempotent =
      mutating &&
      operation.secured &&
      !NO_IDEMPOTENCY_PREFIXES.some((prefix) => path.startsWith(prefix));
    if (idempotent) parameters.push({ $ref: '#/components/parameters/IdempotencyKey' });
    paths[path] ??= {};
    paths[path]![operation.method] = {
      tags: [operation.tag],
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
      ...(mutating && operation.method !== 'delete'
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
