import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeRoutes, evaluate } from '../src/scripts/api-docs/analyze.js';
import { example, fieldRows } from '../src/scripts/api-docs/render.js';
import * as procedures from '../src/modules/procedures/procedure.service.js';
import { loginSchema } from '../src/modules/admin/auth/auth.validation.js';

describe('API documentation generator', () => {
  it('resolves the exact schema instances routes validate with', async () => {
    const routes = await analyzeRoutes(resolve('src/modules/procedures/procedure.routes.ts'));
    const request = routes.find(
      (route) =>
        route.method === 'post' && route.pathText === '/organizations/:organizationId/procedures',
    )!;
    expect(await evaluate(request.schemas.body!.scope, request.schemas.body!.node)).toBe(
      procedures.procedureRequestInput,
    );
    expect(request.targets.map((target) => target.name)).toEqual(['requestProcedure']);
    // Idempotency comes from the handler reading the header, not from a path rule.
    expect(request.idempotent).toBe(true);

    // Paths built in a loop still match every concrete registration.
    const checklist = routes.find((route) => route.pathText.includes('/checklist/'))!;
    expect(
      checklist.pattern.test(
        '/organizations/:organizationId/procedures/:caseId/checklist/time-out',
      ),
    ).toBe(true);

    // `validate({ body })` middleware on the older modules is found too.
    const auth = await analyzeRoutes(resolve('src/modules/admin/auth/auth.routes.ts'));
    const login = auth.find((route) => route.pathText === '/login')!;
    expect(await evaluate(login.schemas.body!.scope, login.schemas.body!.node)).toBe(loginSchema);
    expect(login.idempotent).toBe(false);
  });

  it('flattens nested fields and builds minimal examples', () => {
    const schema = {
      type: 'object',
      required: ['name', 'items'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 20 },
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
              note: { type: 'string' },
            },
          },
        },
      },
    };
    expect(fieldRows(schema).map((row) => [row.field, row.type, row.required])).toEqual([
      ['name', 'string', true],
      ['items', 'object[]', true],
      ['items[].id', 'ObjectId', true],
      ['items[].note', 'string', false],
    ]);
    expect(example(schema)).toEqual({
      name: 'example',
      items: [{ id: '665f1c2e9b1e4a0012345678' }],
    });
  });
});
