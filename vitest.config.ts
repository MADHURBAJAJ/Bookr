import { defineConfig } from 'vitest/config';

// Each test file gets its own in-memory D1 (see test/d1.ts), so files can run in parallel.
export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
