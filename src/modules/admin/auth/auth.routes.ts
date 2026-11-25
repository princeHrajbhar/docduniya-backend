import { Router } from 'express';
import { validate } from '../../../middlewares/validate.js';
import * as controller from './auth.controller.js';
import { protect } from './auth.middleware.js';
import { authLimiter, loginLimiter, otpLimiter, resetPasswordLimiter } from './auth.rate-limit.js';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  googleAuthSchema,
  loginSchema,
  mfaCodeSchema,
  mfaVerifySchema,
  registerSchema,
  resendOtpSchema,
  resetPasswordSchema,
  sessionIdParamsSchema,
  verifyOtpSchema,
} from './auth.validation.js';

const router = Router();

// ── Public ──────────────────────────────────────────────────────────────────
router.post('/register', otpLimiter, validate({ body: registerSchema }), controller.register);
router.post('/verify-otp', authLimiter, validate({ body: verifyOtpSchema }), controller.verifyOtp);
router.post('/resend-otp', otpLimiter, validate({ body: resendOtpSchema }), controller.resendOtp);
router.post('/login', loginLimiter, validate({ body: loginSchema }), controller.login);
router.post('/google', loginLimiter, validate({ body: googleAuthSchema }), controller.googleLogin);
router.post('/mfa/verify', loginLimiter, validate({ body: mfaVerifySchema }), controller.mfaVerify);
router.post('/refresh', authLimiter, controller.refresh);
router.post('/logout', authLimiter, controller.logout);
router.post(
  '/forgot-password',
  otpLimiter,
  validate({ body: forgotPasswordSchema }),
  controller.forgotPassword,
);
router.post(
  '/reset-password',
  resetPasswordLimiter,
  validate({ body: resetPasswordSchema }),
  controller.resetPassword,
);

// ── Authenticated ───────────────────────────────────────────────────────────
router.get('/me', protect, controller.me);
router.get('/sessions', protect, controller.listSessions);
router.delete(
  '/sessions/:sessionId',
  protect,
  validate({ params: sessionIdParamsSchema }),
  controller.revokeSession,
);
router.post('/logout-all', protect, controller.logoutAll);
router.get('/mfa', protect, controller.mfaStatus);
router.post('/mfa/totp/enroll', protect, authLimiter, controller.mfaEnroll);
router.post(
  '/mfa/totp/activate',
  protect,
  authLimiter,
  validate({ body: mfaCodeSchema }),
  controller.mfaActivate,
);
router.post(
  '/mfa/recovery-codes',
  protect,
  authLimiter,
  validate({ body: mfaCodeSchema }),
  controller.mfaRecoveryCodes,
);
router.delete(
  '/mfa/totp',
  protect,
  authLimiter,
  validate({ body: mfaCodeSchema }),
  controller.mfaDisable,
);
router.post(
  '/change-password',
  protect,
  validate({ body: changePasswordSchema }),
  controller.changePassword,
);

export default router;
