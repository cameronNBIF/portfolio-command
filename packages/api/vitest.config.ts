import { defineConfig } from 'vitest/config';

/**
 * The round-trip test destroys the database it runs against, so it runs against
 * a database that exists to be destroyed. See `test/db-setup.ts`.
 */
export default defineConfig({
  test: {
    globalSetup: ['./test/db-setup.ts'],
    setupFiles: ['./test/use-test-db.ts'],
  },
});
