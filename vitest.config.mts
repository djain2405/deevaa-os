import {defineConfig} from 'vitest/config';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {alias: {'@': root}},
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
    env: {
      TZ: 'UTC',
      AUTH_SECRET: 'test-auth-secret-0123456789abcdef0123456789',
      TOKEN_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
      ALLOWED_EMAIL: 'owner@example.com',
      APP_URL: 'http://localhost:3000',
      AUTH_GOOGLE_ID: 'test-client-id',
      AUTH_GOOGLE_SECRET: 'test-client-secret-value'
    }
  }
});
