import { pino } from 'pino';
import { env, isProduction } from './env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    // Never log credentials, one-time codes or tokens, even when nested in objects.
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'password',
      'newPassword',
      'currentPassword',
      'otp',
      'token',
      'refreshToken',
      'accessToken',
      'credential',
      '*.password',
      '*.newPassword',
      '*.otp',
      '*.token',
      '*.refreshToken',
      '*.accessToken',
    ],
    censor: '[REDACTED]',
  },
  ...(isProduction || env.NODE_ENV === 'test'
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
});
