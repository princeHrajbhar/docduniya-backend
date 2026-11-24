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

  it('rejects unsigned gateway webhooks for unknown merchants', async () => {
    const response = await request(app)
      .post(`/api/v1/webhooks/payments/razorpay/${new Types.ObjectId()}`)
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', 'b'.repeat(64))
      .send('{"event":"payment.captured"}');
    expect(response.status).toBe(401);
  });
});
