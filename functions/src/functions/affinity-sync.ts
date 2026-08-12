/**
 * The nightly Affinity sync, as a timer-triggered Azure Function.
 *
 * The schedule is 06:00 UTC — 02:00 or 03:00 Atlantic depending on the season,
 * which is comfortably outside working hours either way. Affinity's date-only
 * fields are anchored to US Pacific midnight, so a run after that boundary sees
 * a settled day rather than one mid-roll.
 *
 * ALL of the logic lives in `sync.ts` and `history.ts`, which know nothing about
 * Azure. This file is the trigger and nothing else, so the sync stays runnable
 * from the CLI — which is how it has actually been exercised, and how the MSP
 * would re-run it at 9pm without a deployment.
 *
 * NOT YET DEPLOYABLE: the Azure resources do not exist (A0, still open). What
 * this needs when they do is `AFFINITY_API_KEY` and `DATABASE_URL` from Key
 * Vault references, never app settings holding the literals.
 */
import { app, type InvocationContext, type Timer } from '@azure/functions';
import pg from 'pg';

import { createAffinityClient } from '../affinity/client.js';
import { syncFieldHistory } from '../affinity/history.js';
import { syncAffinity } from '../affinity/sync.js';

export async function affinitySync(timer: Timer, context: InvocationContext): Promise<void> {
  if (timer.isPastDue) context.warn('Timer is past due; running anyway.');

  const apiKey = process.env.AFFINITY_API_KEY;
  const databaseUrl = process.env.DATABASE_URL;
  if (!apiKey || !databaseUrl) {
    // Thrown, not logged and swallowed: a sync that silently does nothing for a
    // week is worse than one that fails loudly on the first night.
    throw new Error('AFFINITY_API_KEY and DATABASE_URL must both be configured.');
  }

  const af = createAffinityClient(apiKey);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const roster = await syncAffinity(client, af);
    context.log(
      `Roster: ${roster.entriesRead} entries, ${roster.apiCalls} API calls, ` +
        `${JSON.stringify(roster.counts)}`,
    );

    // Warnings are the expected output of a sync against a live CRM and must
    // not fail the run -- an unresolvable VC Lead is a data-quality finding,
    // not an outage. They are logged individually so Application Insights can
    // be queried for a trend rather than a count.
    for (const w of roster.warnings) {
      context.warn(`[${w.kind}] ${w.subject} · ${w.field}: ${w.detail}`);
    }

    const history = await syncFieldHistory(client, af);
    context.log(
      `Change log: ${history.mode}, ${history.fetched} fetched, ${history.stored} stored, ` +
        `${history.apiCalls} API calls`,
    );
  } finally {
    await client.end();
  }
}

app.timer('affinitySync', {
  // sec min hour day month day-of-week
  schedule: '0 0 6 * * *',
  runOnStartup: false,
  handler: affinitySync,
});
