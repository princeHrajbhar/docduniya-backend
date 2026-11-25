import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { User } from '../../src/modules/admin/auth/models/user.model.js';
import { hashPassword } from '../../src/modules/admin/auth/auth.crypto.js';
import { SUPER_ADMIN_ROLE } from '../../src/modules/admin/auth/auth.constants.js';
import { mfaPolicy } from '../../src/modules/admin/auth/mfa/mfa.service.js';
import { base32Decode, currentStep, totpAt } from '../../src/modules/admin/auth/mfa/totp.js';
import { listCredentialReviews } from '../../src/modules/practitioners/credential.service.js';
import { key, startDatabase, stopDatabase } from './support.js';

const app = createApp();
const PASSWORD = 'Synthetic-Passw0rd!';

async function user(role = 'user') {
  const email = `${key()}@example.test`;
  const row = await User.create({
    email,
    password: await hashPassword(PASSWORD),
    isActive: true,
    isVerified: true,
    role,
  });
  return { email, userId: String(row._id) };
}
const login = (email: string) =>
  request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });

beforeAll(startDatabase);
afterAll(async () => {
  mfaPolicy.enforcePrivileged = false;
  await stopDatabase();
});

describe('Two-factor sign-in', () => {
  it('enrolls an authenticator, then requires a single-use second step at sign-in', async () => {
    const admin = await user(SUPER_ADMIN_ROLE);
    const first = await login(admin.email);
    expect(first.status).toBe(200);
    const token = first.body.data.accessToken as string;
    const auth = { Authorization: `Bearer ${token}` };

    const enroll = await request(app).post('/api/v1/auth/mfa/totp/enroll').set(auth);
    expect(enroll.status).toBe(200);
    expect(enroll.headers['cache-control']).toBe('no-store');
    const secret = base32Decode(enroll.body.data.secret as string);
    expect(enroll.body.data.otpauthUri).toMatch(/^otpauth:\/\/totp\//);

    const wrong = await request(app)
      .post('/api/v1/auth/mfa/totp/activate')
      .set(auth)
      .send({ code: '000000' === totpAt(secret, currentStep()) ? '111111' : '000000' });
    expect(wrong.status).toBe(401);
    const activated = await request(app)
      .post('/api/v1/auth/mfa/totp/activate')
      .set(auth)
      .send({ code: totpAt(secret, currentStep()) });
    expect(activated.status).toBe(200);
    const recovery = activated.body.data.recoveryCodes as string[];
    expect(recovery).toHaveLength(10);

    // Password alone no longer yields a session.
    const pending = await login(admin.email);
    expect(pending.status).toBe(200);
    expect(pending.body.data.mfaRequired).toBe(true);
    expect(pending.body.data.accessToken).toBeUndefined();
    expect(pending.headers['set-cookie']).toBeUndefined();
    const challengeToken = pending.body.data.challengeToken as string;

    // The code used for activation cannot be replayed.
    const replay = await request(app)
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken, code: totpAt(secret, currentStep()) });
    expect(replay.status).toBe(401);
    // A recovery code works once.
    const recovered = await request(app)
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken, recoveryCode: recovery[0] });
    expect(recovered.status).toBe(200);
    expect(recovered.body.data.accessToken).toBeTruthy();
    const again = await login(admin.email);
    const reused = await request(app)
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: again.body.data.challengeToken, recoveryCode: recovery[0] });
    expect(reused.status).toBe(401);
    // A consumed challenge cannot mint a second session.
    const consumed = await request(app)
      .post('/api/v1/auth/mfa/verify')
      .send({ challengeToken, recoveryCode: recovery[1] });
    expect(consumed.status).toBe(401);

    const status = await request(app)
      .get('/api/v1/auth/mfa')
      .set({ Authorization: `Bearer ${recovered.body.data.accessToken as string}` });
    expect(status.body.data).toMatchObject({ enrolled: true, recoveryCodesRemaining: 9 });
  });

  it('blocks privileged administration until a factor is enrolled when enforcement is on', async () => {
    const admin = await user(SUPER_ADMIN_ROLE);
    mfaPolicy.enforcePrivileged = true;
    try {
      await expect(
        listCredentialReviews({ userId: admin.userId, requestId: key() }, { limit: 10 }),
      ).rejects.toMatchObject({ statusCode: 403, code: 'MFA_ENROLLMENT_REQUIRED' });
    } finally {
      mfaPolicy.enforcePrivileged = false;
    }
    await expect(
      listCredentialReviews({ userId: admin.userId, requestId: key() }, { limit: 10 }),
    ).resolves.toMatchObject({ items: [] });
  });
});
