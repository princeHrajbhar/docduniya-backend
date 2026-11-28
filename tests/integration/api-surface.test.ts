import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../../src/app.js';
import {
  account,
  key,
  patient,
  platformAdmin,
  provider,
  startDatabase,
  stopDatabase,
  type Identity,
} from './support.js';

const app = createApp();
let owner: Identity;
let clinic: { organizationId: string; facilityId: string };

beforeAll(async () => {
  await startDatabase();
  owner = await account();
  clinic = await provider(owner, await platformAdmin());
});
afterAll(stopDatabase);

describe('HTTP surface', () => {
  it('serves public catalogs without credentials and with no-store caching', async () => {
    for (const path of [
      '/api/v1/subscription-plans',
      '/api/v1/policies',
      '/api/v1/diagnostic-tests',
      '/api/v1/drugs',
      `/api/v1/doctors/${new Types.ObjectId()}/reviews`,
    ]) {
      const response = await request(app).get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers['cache-control'], path).toBe('no-store');
    }
  });

  it('requires authentication for private resources and idempotency keys for commands', async () => {
    const someone = new Types.ObjectId();
    for (const path of [
      `/api/v1/patients/${someone}/clinical-records`,
      '/api/v1/me/notifications',
      `/api/v1/organizations/${clinic.organizationId}/invoices`,
    ])
      expect((await request(app).get(path)).status, path).toBe(401);
    const missingKey = await request(app)
      .post(`/api/v1/organizations/${clinic.organizationId}/locations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ facilityId: clinic.facilityId, code: 'STORE-1', name: 'Store', kind: 'STORE' });
    expect(missingKey.status).toBe(400);
    expect(missingKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('returns validation errors for unknown fields and hides other tenants', async () => {
    const strict = await request(app)
      .post(`/api/v1/organizations/${clinic.organizationId}/invoices`)
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', key())
      .send({ patientRegistrationId: String(new Types.ObjectId()), totalMinor: 1 });
    expect(strict.status).toBe(400);
    const outsider = await account();
    const hidden = await request(app)
      .get(`/api/v1/organizations/${clinic.organizationId}/ledger/trial-balance`)
      .set('Authorization', `Bearer ${outsider.token}`);
    expect(hidden.status).toBe(404);
    const own = await request(app)
      .get(`/api/v1/organizations/${clinic.organizationId}/ledger/trial-balance`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(own.status).toBe(200);
    expect(own.body.data.balanced).toBe(true);
  });

  it('runs a patient portal request end to end', async () => {
    const identity = await account();
    const profile = await patient(identity);
    const response = await request(app)
      .get(`/api/v1/patients/${profile.id}/clinical-records`)
      .set('Authorization', `Bearer ${identity.token}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ prescriptions: [], notes: [], visits: [] });
    const notStore = await request(app)
      .get(`/api/v1/patients/${profile.id}/export`)
      .set('Authorization', `Bearer ${identity.token}`);
    expect(notStore.status).toBe(200);
    expect(notStore.body.data.format).toBe('docduniya-patient-export');
    const intruder = await account();
    expect(
      (
        await request(app)
          .get(`/api/v1/patients/${profile.id}/export`)
          .set('Authorization', `Bearer ${intruder.token}`)
      ).status,
    ).toBe(404);
  });

  it('reports readiness only with a replica-set database', async () => {
    const ready = await request(app).get('/api/v1/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ready');
  });

  it('publishes an OpenAPI contract generated from the mounted routes', async () => {
    const response = await request(app).get('/api/v1/openapi.json');
    expect(response.status).toBe(200);
    const spec = response.body as {
      openapi: string;
      paths: Record<
        string,
        Record<
          string,
          { security: unknown[]; parameters?: Array<{ $ref?: string; name?: string }> }
        >
      >;
    };
    expect(spec.openapi).toBe('3.1.0');
    const operations = Object.values(spec.paths).flatMap((path) => Object.keys(path));
    expect(operations.length).toBeGreaterThan(250);
    const claim = spec.paths['/organizations/{organizationId}/claims']!.post!;
    expect(claim.security).toEqual([{ bearerAuth: [] }, { cookieAuth: [] }]);
    expect(claim.parameters).toContainEqual({ $ref: '#/components/parameters/IdempotencyKey' });
    expect(claim.parameters).toContainEqual(expect.objectContaining({ name: 'organizationId' }));
    expect(spec.paths['/discovery/concerns']!.get!.security).toEqual([]);
    expect(spec.paths['/auth/login']!.post!.parameters).toBeUndefined();
    expect(spec.paths['/webhooks/payments/razorpay/{merchantAccountId}']).toBeDefined();
  });

  it('marks the account’s own patient profile in the profile list', async () => {
    const person = await account();
    const own = await patient(person, 'Own Profile');
    const list = await request(app)
      .get('/api/v1/me/patients')
      .set('Authorization', `Bearer ${person.token}`);
    expect(list.status).toBe(200);
    expect(list.body.data.items).toEqual([
      expect.objectContaining({ id: own.id, self: true, status: 'ACTIVE' }),
    ]);
    expect(list.body.data.items[0]).not.toHaveProperty('ownerUserId');
  });

  it('lists the caller’s workspaces with roles, effective permissions and invitations', async () => {
    const mine = await request(app)
      .get('/api/v1/me/workspaces')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(mine.status).toBe(200);
    expect(mine.headers['cache-control']).toBe('no-store');
    const workspace = mine.body.data.workspaces.find(
      (item: { organization: { id: string } }) => item.organization.id === clinic.organizationId,
    );
    expect(workspace.organization).toMatchObject({
      displayName: 'Synthetic Provider',
      status: 'ACTIVE',
    });
    expect(workspace.roles.map((role: { slug: string }) => role.slug)).toContain('owner');
    expect(workspace.permissions).toContain('organization.manage');
    // Administration never implies clinical access.
    expect(workspace.permissions).not.toContain('clinical.read');

    const receptionist = await account();
    const invite = await request(app)
      .post(`/api/v1/organizations/${clinic.organizationId}/memberships`)
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', key())
      .send({
        userId: receptionist.userId,
        role: 'receptionist',
        facilityScope: 'SELECTED',
        facilityIds: [clinic.facilityId],
      });
    expect(invite.status).toBe(201);
    const invited = await request(app)
      .get('/api/v1/me/workspaces')
      .set('Authorization', `Bearer ${receptionist.token}`);
    expect(invited.body.data.workspaces).toEqual([]);
    expect(invited.body.data.invitations).toHaveLength(1);
    expect(invited.body.data.invitations[0].organization.id).toBe(clinic.organizationId);

    const accepted = await request(app)
      .post(`/api/v1/me/memberships/${invite.body.data.id}/accept`)
      .set('Authorization', `Bearer ${receptionist.token}`)
      .set('Idempotency-Key', key())
      .send({ expectedVersion: invite.body.data.version });
    expect(accepted.status).toBe(200);
    const member = await request(app)
      .get('/api/v1/me/workspaces')
      .set('Authorization', `Bearer ${receptionist.token}`);
    expect(member.body.data.invitations).toEqual([]);
    const [desk] = member.body.data.workspaces;
    expect(desk.facilityScope).toBe('SELECTED');
    expect(desk.facilityIds).toEqual([clinic.facilityId]);
    expect(desk.roles).toEqual([expect.objectContaining({ slug: 'receptionist' })]);
    expect(desk.permissions).toEqual(
      expect.arrayContaining(['appointments.manage', 'queue.manage']),
    );
    expect(desk.permissions).not.toContain('memberships.manage');
  });

  it('rejects unsigned gateway webhooks for unknown merchants', async () => {
    const response = await request(app)
      .post(`/api/v1/webhooks/payments/razorpay/${new Types.ObjectId()}`)
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', 'b'.repeat(64))
      .send('{"event":"payment.captured"}');
    expect(response.status).toBe(401);
  });
});
