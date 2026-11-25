import { defineConfig } from 'vitest/config';

// Unit tests only. The Playwright suite (tests/*.spec.ts) is run by `npm run test:e2e`.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
