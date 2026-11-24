import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    fileParallelism: false,
    hookTimeout: 180_000,
    testTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      MONGO_URI: 'mongodb://127.0.0.1:27018/docduniya-test',
      JWT_ACCESS_SECRET: 'test-only-access-secret-at-least-32-characters',
    },
  },
});
