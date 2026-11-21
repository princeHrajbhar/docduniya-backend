import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDB, disconnectDB } from './config/db.js';
import { ensureSystemRoles } from './modules/admin/auth/index.js';
import { closeEmailProvider, verifyEmailProvider } from './modules/email/index.js';

async function verifyEmailOnStart(): Promise<void> {
  if (!env.VERIFY_SMTP_ON_START) return;
  try {
    await verifyEmailProvider();
  } catch (err) {
    logger.error(
      { err },
      env.EMAIL_REQUIRED_ON_START
        ? 'Email provider verification failed'
        : 'Email provider verification failed; API continues in degraded email mode',
    );
    if (env.EMAIL_REQUIRED_ON_START) throw err;
  }
}

async function start(): Promise<void> {
  await connectDB();
  await ensureSystemRoles();
  await verifyEmailOnStart();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`Server running on http://localhost:${env.PORT} [${env.NODE_ENV}]`);
  });

  // Bound header exposure while still allowing large uploads.
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.requestTimeout = 15 * 60 * 1000;

  let stopping = false;
  const shutdown = (signal: string, exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal} received, shutting down gracefully...`);
    server.close(async (err) => {
      if (err) logger.error({ err }, 'Error during shutdown');
      closeEmailProvider();
      await disconnectDB().catch((dbError: unknown) =>
        logger.error({ err: dbError }, 'Error closing MongoDB'),
      );
      logger.info('Server closed');
      process.exit(err ? 1 : exitCode);
    });
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled promise rejection');
    shutdown('unhandledRejection', 1);
  });
}

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

start().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
