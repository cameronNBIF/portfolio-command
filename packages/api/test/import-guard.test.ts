/**
 * The fixture importer refuses to overwrite the real roster.
 *
 * WHY THIS TEST EXISTS, stated plainly because the guard it covers looks like
 * defensive clutter until you know what it cost. `importContract` truncates
 * eight root tables with `cascade`, which is correct for the round trip and
 * catastrophic against a working database. A6 built `<database>_test` isolation
 * after the round-trip TEST wiped the development roster twice. That fixed the
 * test path and left the CLI path, which issues the identical truncate against
 * `DATABASE_URL` itself -- and it wiped the dev database twice more during A8,
 * costing a full rebuild each time and a session of chasing the wrong suspect.
 *
 * A guard nothing exercises is a guard that gets deleted in a refactor by
 * someone who cannot see what it is for. So it is exercised here, end to end
 * through the actual CLI rather than by calling a helper -- the failure mode
 * being defended against is the whole command doing the wrong thing, and a unit
 * test of an exported predicate would not have caught the two false positives
 * that showed up the first time this was written.
 *
 * REQUIRES A DATABASE. Skipped when DATABASE_URL is unset, matching the other
 * suites; the database CI job sets it.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'kysely';

import { closeDb, db } from '../src/db.js';
import { assertTestDatabase } from './use-test-db.js';

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env') });

const hasDb = Boolean(process.env.DATABASE_URL);
const CLI = path.resolve(here, '../src/import/cli.ts');
const COMPANY = 'PCGUARD1';

/**
 * Runs the CLI the way a developer would, against the TEST database.
 *
 * `process.execPath` with the tsx loader rather than `npm run`: npm resolves to
 * npm.cmd on Windows and execFile refuses to spawn a .cmd without a shell. Same
 * reason `db-setup.ts` shells out this way.
 */
async function runCli(args: string[] = []): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', CLI, ...args],
      { env: { ...process.env }, cwd: path.resolve(here, '../..') },
    );
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

describe.skipIf(!hasDb)('the fixture importer guards the real roster', () => {
  beforeEach(async () => {
    // The --force case truncates eight root tables, and this suite spawns the
    // CLI, so the child inherits whatever this process is pointed at.
    assertTestDatabase();
    await sql`delete from pc.company where company_id = ${COMPANY}`.execute(db());
  });

  afterAll(async () => {
    await sql`delete from pc.company where company_id = ${COMPANY}`.execute(db()).catch(() => {});
    await closeDb();
  });

  /**
   * The common case, and the one that decides whether the guard is usable. An
   * empty database and a database holding a previous fixture load are both safe
   * to overwrite; if the guard fired on either, it would fire on the normal path
   * and get routed around with --force out of habit.
   *
   * This is not a hypothetical worry. The first version of this guard probed
   * `company_kpi.source_system = 'visible'` and `transaction.is_synthetic`, and
   * BOTH fire on plain fixture data -- the column defaults to 'visible' and the
   * fixture genuinely is synthetic. It refused to load a fixture over a fixture.
   */
  test('loads over fixture-only data without complaint', async () => {
    const { code, out } = await runCli();
    expect(out).not.toMatch(/Refusing to import/);
    expect(code).toBe(0);
  });

  /**
   * `affinity_org_id` is the one exact discriminator: the importer never writes
   * it and the sync always does. One synced company is enough, because
   * everything else at risk -- Visible history, the generated financial spine,
   * captured rounds -- arrives downstream of that roster.
   */
  test('refuses when a synced roster is present, and says what would be lost', async () => {
    await sql`
      insert into pc.company (company_id, name, affinity_org_id, created_by)
      values (${COMPANY}, 'Guard Test Co', 999999999,
              (select user_id from pc.app_user limit 1))
    `.execute(db());

    const { code, out } = await runCli();

    expect(code).not.toBe(0);
    expect(out).toMatch(/Refusing to import/);
    expect(out).toMatch(/companies synced from Affinity/);
    // The recovery route is part of the contract with the reader: a refusal that
    // does not say how to proceed just gets --force'd blindly.
    expect(out).toMatch(/db:reset/);
    expect(out).toMatch(/--force/);

    // and it refused before truncating anything
    const { rows } = await sql<{ n: string }>`
      select count(*)::text as n from pc.company where company_id = ${COMPANY}
    `.execute(db());
    expect(rows[0]!.n).toBe('1');
  });

  test('--force overwrites, and says so rather than proceeding quietly', async () => {
    await sql`
      insert into pc.company (company_id, name, affinity_org_id, created_by)
      values (${COMPANY}, 'Guard Test Co', 999999999,
              (select user_id from pc.app_user limit 1))
    `.execute(db());

    const { code, out } = await runCli(['--force']);

    expect(code).toBe(0);
    expect(out).toMatch(/Overwriting the real roster/);

    // The truncate did happen, which is what --force is for.
    const { rows } = await sql<{ n: string }>`
      select count(*)::text as n from pc.company where company_id = ${COMPANY}
    `.execute(db());
    expect(rows[0]!.n).toBe('0');
  });
});
