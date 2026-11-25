/**
 * Writes the OpenAPI contract to docs/api/openapi.json for client generation. It only loads the
 * route modules; no database connection is opened.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

process.env.LOG_LEVEL ??= 'silent';
const { ROUTE_GROUPS } = await import('../routes/index.js');
const { webhookRouter } = await import('../modules/billing/billing.routes.js');
const { buildOpenApi } = await import('../shared/http/openapi.js');

const target = resolve('docs/api/openapi.json');
const spec = buildOpenApi(ROUTE_GROUPS, {
  version: process.env.npm_package_version ?? '1.0.0',
  extra: [{ tag: 'Payment webhooks', prefix: '/webhooks', router: webhookRouter }],
});
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(spec, null, 2)}\n`);
// eslint-disable-next-line no-console -- command-line output
console.log(`Wrote ${Object.keys(spec.paths).length} paths to ${target}`);
