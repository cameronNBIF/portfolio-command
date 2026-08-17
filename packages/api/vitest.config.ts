import { defineConfig } from 'vitest/config';

/**
 * The round-trip test destroys the database it runs against, so it runs against
 * a database that exists to be destroyed. See `test/db-setup.ts`.
 */
export default defineConfig({
  test: {
    globalSetup: ['./test/db-setup.ts'],
    setupFiles: ['./test/use-test-db.ts'],

    /**
     * ONE FILE AT A TIME, because there is one test database.
     *
     * `round-trip.test.ts` truncates every root table and reloads `demo.json`
     * before asserting the frozen board numbers; `financial-versioning.test.ts`
     * inserts transactions of its own. Run concurrently they interleave, and the
     * symptom is the worst kind — the golden-master assertion fails, which is
     * the alarm that is supposed to mean "a board number moved". An alarm that
     * cries wolf on a scheduling race is worse than no alarm.
     *
     * Sequential is safe rather than merely quieter: `closeDb()` nulls the
     * singleton, so a later file's first `db()` builds a fresh pool.
     */
    fileParallelism: false,
  },
});
