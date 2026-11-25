import type { Request, Response } from 'express';
import { AppError, ErrorCode } from '../../../utils/app-error.js';
import { EMAIL_DELIVERY_HINT } from '../../email/index.js';
import { clearAuthCookies, readRefreshCookie, setAuthCookies } from './auth.cookies.js';
import * as authService from './auth.service.js';
import type { AuthTokens, SessionMeta } from './auth.types.js';
import * as mfa from './mfa/mfa.service.js';
import type {
  ChangePasswordInput,
  LoginInput,
  RegisterInput,
  ResendOtpInput,
  ResetPasswordInput,
  VerifyOtpInput,
} from './auth.validation.js';

// Express 5 forwards rejected promises to the error handler, so no try/catch is needed.

const sessionMeta = (req: Request): SessionMeta => ({
  userAgent: req.get('user-agent'),
  ip: req.ip || req.socket.remoteAddress,
});

export async function register(req: Request, res: Response) {
  const data = await authService.register(req.body as RegisterInput);
  res.status(201).json({
    success: true,
    message: `Registration successful. Please check your email for the verification code. ${EMAIL_DELIVERY_HINT}`,
    data,
  });
}

export async function verifyOtp(req: Request, res: Response) {
  const data = await authService.verifyEmail(req.body as VerifyOtpInput);
  res.json({ success: true, message: 'Email verified successfully', data });
}

export async function resendOtp(req: Request, res: Response) {
  const { email, type } = req.body as ResendOtpInput;
  const { message } = await authService.resendCode(email, type);
  res.json({ success: true, message });
}

/** A pending second factor returns a short-lived challenge instead of a session. */
function mfaPending(res: Response, result: object): boolean {
  if (!('mfaRequired' in result)) return false;
  const pending = result as unknown as { challengeToken: string; expiresAt: Date };
  res.json({
    success: true,
    message: 'Enter the code from your authenticator app',
    data: {
      mfaRequired: true,
      challengeToken: pending.challengeToken,
      expiresAt: pending.expiresAt,
    },
  });
  return true;
}

export async function login(req: Request, res: Response) {
  const { email, password } = req.body as LoginInput;
  const result = await authService.login(email, password, sessionMeta(req));
  if (mfaPending(res, result)) return;
  const tokens = result as AuthTokens;
  setAuthCookies(res, tokens);
  // The access token is also returned for clients using `Authorization: Bearer`.
  res.json({
    success: true,
    message: 'Logged in successfully',
    data: { accessToken: tokens.accessToken },
  });
}

export async function googleLogin(req: Request, res: Response) {
  const result = await authService.loginWithGoogle(
    (req.body as { credential: string }).credential,
    sessionMeta(req),
  );
  if (mfaPending(res, result)) return;
  const tokens = result as AuthTokens;
  setAuthCookies(res, tokens);
  res.json({
    success: true,
    message: 'Signed in with Google successfully',
    data: { accessToken: tokens.accessToken },
  });
}

export async function refresh(req: Request, res: Response) {
  const refreshToken = readRefreshCookie(req);
  if (!refreshToken) throw new AppError('No refresh token provided', 401, ErrorCode.TOKEN_INVALID);

  try {
    const tokens = await authService.refresh(refreshToken);
    setAuthCookies(res, tokens);
    res.json({
      success: true,
      message: 'Tokens refreshed',
      data: { accessToken: tokens.accessToken },
    });
  } catch (error) {
    // A refresh token that cannot be used is dead: drop it from the browser.
    clearAuthCookies(res);
    throw error;
  }
}

export async function logout(req: Request, res: Response) {
  const refreshToken = readRefreshCookie(req);
  if (refreshToken) await authService.logout(refreshToken);
  clearAuthCookies(res);
  res.json({ success: true, message: 'Logged out successfully' });
}

export async function logoutAll(req: Request, res: Response) {
  await authService.logoutAll(req.user!.userId);
  clearAuthCookies(res);
  res.json({ success: true, message: 'Logged out from all devices' });
}

export async function forgotPassword(req: Request, res: Response) {
  const { message } = await authService.forgotPassword((req.body as { email: string }).email);
  res.json({ success: true, message });
}

export async function resetPassword(req: Request, res: Response) {
  const { message } = await authService.resetPassword(req.body as ResetPasswordInput);
  clearAuthCookies(res);
  res.json({ success: true, message });
}

export async function changePassword(req: Request, res: Response) {
  const { userId, sessionId } = req.user!;
  const { message } = await authService.changePassword(
    userId,
    sessionId,
    req.body as ChangePasswordInput,
  );
  res.json({ success: true, message });
}

export async function listSessions(req: Request, res: Response) {
  const sessions = await authService.listSessions(req.user!.userId, req.user!.sessionId);
  res.json({ success: true, data: { sessions } });
}

export async function revokeSession(req: Request<{ sessionId: string }>, res: Response) {
  await authService.revokeOwnSession(req.user!.userId, req.params.sessionId);
  if (req.params.sessionId === req.user!.sessionId) clearAuthCookies(res);
  res.json({ success: true, message: 'Session revoked' });
}

export async function me(req: Request, res: Response) {
  res.json({ success: true, data: await authService.getCurrentUser(req.user!.userId) });
}

// ── Second factor ──────────────────────────────────────────────────────────

export async function mfaVerify(req: Request, res: Response) {
  const tokens = await mfa.completeSignIn(
    req.body as { challengeToken: string; code?: string; recoveryCode?: string },
    sessionMeta(req),
  );
  setAuthCookies(res, tokens);
  res.json({
    success: true,
    message: 'Logged in successfully',
    data: { accessToken: tokens.accessToken },
  });
}

export async function mfaStatus(req: Request, res: Response) {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await mfa.mfaStatus(req.user!.userId) });
}

export async function mfaEnroll(req: Request, res: Response) {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await mfa.startEnrollment(req.user!.userId) });
}

export async function mfaActivate(req: Request, res: Response) {
  res.set('Cache-Control', 'no-store');
  const { code } = req.body as { code: string };
  res.json({
    success: true,
    message: 'Authenticator enabled; other sessions were signed out',
    data: await mfa.activateEnrollment(req.user!.userId, code, req.user!.sessionId),
  });
}

export async function mfaRecoveryCodes(req: Request, res: Response) {
  res.set('Cache-Control', 'no-store');
  const { code } = req.body as { code: string };
  res.json({ success: true, data: await mfa.regenerateRecoveryCodes(req.user!.userId, code) });
}

export async function mfaDisable(req: Request, res: Response) {
  const { code } = req.body as { code: string };
  const privileged = req.user!.permissions.length > 0;
  res.json({ success: true, data: await mfa.disableFactor(req.user!.userId, code, privileged) });
}
