import express from 'express';
import helmet from 'helmet';
import cors, { type CorsOptions } from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { env, isProduction } from './config/env.js';
import { logger } from './config/logger.js';
import routes from './routes/index.js';
import { notFound } from './middlewares/not-found.js';
import { errorHandler } from './middlewares/error-handler.js';
import { createRateLimiter } from './middlewares/rate-limit.js';
import { crossSiteMutationGuard, requestShapeGuard } from './middlewares/request-protection.js';

/**
 * Cookie-based auth requires credentialed CORS, which cannot use `*`. Allowed
 * origins are FRONTEND_URL plus CORS_ORIGINS / CORS_ORIGIN (comma separated,
 * `https://*.example.com` wildcards supported) and localhost in development.
 */
function buildCorsOptions(): CorsOptions {
  const configured = [
    env.FRONTEND_URL,
    ...env.CORS_ORIGINS.split(','),
    ...env.CORS_ORIGIN.split(','),
    ...(isProduction ? [] : ['http://localhost:3000', 'http://127.0.0.1:3000']),
  ]
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter((value) => value && value !== '*');

  const exact = new Set(configured.filter((value) => !value.includes('*')));
  const patterns = configured
    .filter((value) => value.includes('*'))
    .map(
      (value) =>
        new RegExp(`^${value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/.]+')}$`),
    );

  return {
    credentials: true,
    origin(origin, callback) {
      // Server-to-server calls and same-origin requests may not send Origin.
      const normalized = origin?.replace(/\/$/, '');
      if (
        !normalized ||
        exact.has(normalized) ||
        patterns.some((pattern) => pattern.test(normalized))
      ) {
        callback(null, true);
        return;
      }
      callback(new Error('Origin is not allowed by CORS'));
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  };
}

export const createApp = () => {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.set('query parser', 'simple');

  // Security & performance
  app.use(helmet());
  app.use(cors(buildCorsOptions()));
  app.use(compression());
  app.use(
    createRateLimiter({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      limit: env.RATE_LIMIT_MAX,
      skip: (req) => req.method === 'OPTIONS' || req.path === '/api/v1/health',
    }),
  );

  // Body parsing & logging
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(pinoHttp({ logger }));

  // Routes
  app.use('/api/v1', crossSiteMutationGuard, requestShapeGuard, routes);

  // 404 + error handling (must be last)
  app.use(notFound);
  app.use(errorHandler);

  return app;
};
