import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      MONGO_URI: 'mongodb://127.0.0.1:27017/docduniya-test',
      JWT_ACCESS_SECRET: 'test-only-access-secret-at-least-32-characters',
    },
    coverage: { provider: 'v8', reporter: ['text', 'html'], include: ['src/**/*.ts'] },
  },
});
