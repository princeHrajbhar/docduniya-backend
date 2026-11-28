import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { User } from '../../src/modules/admin/auth/models/user.model.js';
import { AdminSignInChallenge } from '../../src/modules/admin/auth/models/admin-signin.model.js';
import { hashPassword } from '../../src/modules/admin/auth/auth.crypto.js';
import { SUPER_ADMIN_ROLE } from '../../src/modules/admin/auth/auth.constants.js';
import { adminCodeDelivery } from '../../src/modules/admin/auth/admin-login.service.js';
import { key, startDatabase, stopDatabase } from './support.js';

const app = createApp();
const PASSWORD = 'Synthetic-Passw0rd!';
const original = adminCodeDelivery.send;
let sent: Array<{ to: string; code: string }> = [];

async function user(role = 'user') {
  const email = `${key()}@example.test`;
  await User.create({
    email,
    password: await hashPassword(PASSWORD),
    isActive: true,
    isVerified: true,
    role,
  });
  return email;
}
/** A distinct client address per call keeps the per-IP limiters out of the way. */
const client = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.7`;
const post = (path: string, body: object) =>
  request(app).post(`/api/v1${path}`).set('X-Forwarded-For', client()).send(body);
const codeFor = (email: string) => sent.filter((mail) => mail.to === email).at(-1)?.code;

beforeAll(async () => {
  await startDatabase();
  // Capture codes instead of sending email.
  adminCodeDelivery.send = async (to: string, code: string) => {
    sent.push({ to, code });
    return { messageId: 'test', to };
  };
});
afterAll(async () => {
  adminCodeDelivery.send = original;
  await stopDatabase();
});
beforeEach(() => {
  sent = [];
});

describe('Administrator portal sign-in', () => {
  it('emails a code on every sign-in and creates the session only after the code', async () => {
    const admin = await user(SUPER_ADMIN_ROLE);
    const first = await post('/auth/admin/login', { email: admin, password: PASSWORD });
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.body.data).toMatchObject({ verificationRequired: true });
    expect(first.body.data.sentTo).toMatch(/^\w{2}\*+@example\.test$/);
    // Password alone gives no session.
    expect(first.body.data.accessToken).toBeUndefined();
    expect(first.headers['set-cookie']).toBeUndefined();
    const code = codeFor(admin)!;
    expect(code).toMatch(/^\d{6}$/);
    const challengeToken = first.body.data.challengeToken as string;

    const wrong = await post('/auth/admin/verify', {
      challengeToken,
      code: code === '000000' ? '111111' : '000000',
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('OTP_INVALID');

    const verified = await post('/auth/admin/verify', { challengeToken, code });
    expect(verified.status).toBe(200);
    expect(String(verified.headers['set-cookie'])).toMatch(/accessToken=.*refreshToken=/s);
    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${verified.body.data.accessToken as string}`);
    expect(me.body.data).toMatchObject({ email: admin, role: SUPER_ADMIN_ROLE });

    // The challenge is single use, and the next sign-in needs a new emailed code.
    expect((await post('/auth/admin/verify', { challengeToken, code })).status).toBe(401);
    await AdminSignInChallenge.updateMany({}, { $set: { lastSentAt: new Date(0) } });
    const second = await post('/auth/admin/login', { email: admin, password: PASSWORD });
    expect(second.status).toBe(200);
    expect(sent.filter((mail) => mail.to === admin)).toHaveLength(2);
  });

  it('refuses patients and doctors without revealing that the password was right', async () => {
    const patient = await user();
    const response = await post('/auth/admin/login', { email: patient, password: PASSWORD });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('INVALID_CREDENTIALS');
    expect(sent).toHaveLength(0);
    const wrongPassword = await post('/auth/admin/login', {
      email: patient,
      password: 'Wrong-Passw0rd!',
    });
    expect(wrongPassword.body).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    // The patient sign-in still works for them.
    expect((await post('/auth/login', { email: patient, password: PASSWORD })).status).toBe(200);
  });

  it('sends administrators away from the patient and doctor sign-in', async () => {
    const admin = await user(SUPER_ADMIN_ROLE);
    const response = await post('/auth/login', { email: admin, password: PASSWORD });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('ADMIN_LOGIN_REQUIRED');
    expect(response.headers['set-cookie']).toBeUndefined();
    // A wrong password there is still just a wrong password.
    const wrong = await post('/auth/login', { email: admin, password: 'Wrong-Passw0rd!' });
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('limits attempts, supersedes older attempts and rotates the code on resend', async () => {
    const admin = await user(SUPER_ADMIN_ROLE);
    const first = await post('/auth/admin/login', { email: admin, password: PASSWORD });
    const firstToken = first.body.data.challengeToken as string;
    const firstCode = codeFor(admin)!;

    // Within the cooldown neither a new sign-in nor a resend sends another email.
    expect((await post('/auth/admin/login', { email: admin, password: PASSWORD })).status).toBe(
      429,
    );
    expect((await post('/auth/admin/resend-code', { challengeToken: firstToken })).status).toBe(
      429,
    );
    expect(sent).toHaveLength(1);

    // After the cooldown, a resend replaces the code: the old one stops working.
    await AdminSignInChallenge.updateMany({}, { $set: { lastSentAt: new Date(0) } });
    const resent = await post('/auth/admin/resend-code', { challengeToken: firstToken });
    expect(resent.status).toBe(200);
    const newCode = codeFor(admin)!;
    if (newCode !== firstCode)
      expect(
        (await post('/auth/admin/verify', { challengeToken: firstToken, code: firstCode })).status,
      ).toBe(401);

    // A newer sign-in closes the older attempt.
    await AdminSignInChallenge.updateMany({}, { $set: { lastSentAt: new Date(0) } });
    const second = await post('/auth/admin/login', { email: admin, password: PASSWORD });
    expect(
      (await post('/auth/admin/verify', { challengeToken: firstToken, code: newCode })).status,
    ).toBe(401);

    // Five wrong codes end the attempt even for the right code.
    const secondToken = second.body.data.challengeToken as string;
    const secondCode = codeFor(admin)!;
    const bad = secondCode === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1)
      await post('/auth/admin/verify', { challengeToken: secondToken, code: bad });
    const locked = await post('/auth/admin/verify', {
      challengeToken: secondToken,
      code: secondCode,
    });
    expect(locked.status).toBe(401);
    expect(locked.headers['set-cookie']).toBeUndefined();
  });

  it('refuses the code if the account was disabled after the password step', async () => {
    const admin = await user(SUPER_ADMIN_ROLE);
    const started = await post('/auth/admin/login', { email: admin, password: PASSWORD });
    await User.updateOne({ email: admin }, { $set: { isActive: false } });
    const response = await post('/auth/admin/verify', {
      challengeToken: started.body.data.challengeToken,
      code: codeFor(admin),
    });
    expect(response.status).toBe(403);
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});
