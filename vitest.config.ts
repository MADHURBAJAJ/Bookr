import { defineConfig } from 'vitest/config';

// Each test file gets its own copy of the test database (see test/d1.ts; D1_REAL=1 for wrangler's local D1), so files can run in parallel.
export default defineConfig({
  test: {
    testTimeout: 30000,
    // Worktrees made by Claude Code sit under .claude/ and hold copies of the tests.
    // listener/ is a separate Node program with its own tests (node --test, run there with npm test).
    exclude: ['**/node_modules/**', '.claude/**', 'listener/**'],
    hookTimeout: 60000,
  },
});
