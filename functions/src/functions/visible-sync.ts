/**
 * The Visible KPI sync, as a timer-triggered Azure Function.
 *
 * The schedule is 07:00 UTC — an hour after the Affinity sync, so the company
 * roster is already refreshed when this runs. That ordering matters: the join
 * is on website, and a company whose domain was corrected in Affinity overnight
 * should be matchable on the same night rather than the next one.
 *
 * DAILY, THOUGH THE DATA IS QUARTERLY. Visible submissions do not arrive on the
 * due date; they trickle in over the weeks after it, and a founder can restate a
 * past quarter at any time. A daily full refresh costs about a hundred API calls
 * and keeps the platform at most a day behind. A quarterly schedule would mean
 * the board pack is assembled from whatever had been submitted on one arbitrary
 * morning.
 *
 * ALL of the logic lives in `sync.ts`, which knows nothing about Azure, so the
 * sync stays runnable from the CLI — which is how it has actually been
 * exercised, and how the MSP would re-run it at 9pm without a deployment.
 *
 * NOT YET DEPLOYABLE: the Azure resources do not exist (A0, still open). What
 * this needs when they do is `VISIBLE_ACCESS_TOKEN`, `VISIBLE_COMPANY_ID` and
 * `DATABASE_URL` from Key Vault references, never app settings holding the
 * literals.
 */
import { app, type InvocationContext, type Timer } from '@azure/functions';
import pg from 'pg';

import { createVisibleClient } from '../visible/client.js';
import { syncVisible } from '../visible/sync.js';

export async function visibleSync(timer: Timer, context: InvocationContext): Promise<void> {
  if (timer.isPastDue) context.warn('Timer is past due; running anyway.');

  const token = process.env.VISIBLE_ACCESS_TOKEN;
  const companyId = process.env.VISIBLE_COMPANY_ID;
  const databaseUrl = process.env.DATABASE_URL;
  if (!token || !companyId || !databaseUrl) {
    // Thrown, not logged and swallowed: a sync that silently does nothing for a
    // quarter is worse than one that fails loudly on the first night.
    throw new Error(
      'VISIBLE_ACCESS_TOKEN, VISIBLE_COMPANY_ID and DATABASE_URL must all be configured.',
    );
  }

  const vis = createVisibleClient(token);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const result = await syncVisible(client, vis, { companyId });
    context.log(
      `Visible KPIs: ${result.profilesRead} profiles, ${result.companiesMatched} matched, ` +
        `${result.dataPointsRead} data points, ${result.apiCalls} API calls, ` +
        `${JSON.stringify(result.counts)}`,
    );

    // Warnings are the expected output of a sync against a live reporting
    // platform and must not fail the run -- a company that has not answered this
    // quarter is not an outage. They are logged individually so Application
    // Insights can be queried for a trend rather than a count, and the
    // unmatched-* ones in particular are the only signal that a rebrand has
    // quietly detached a company's KPI history (ADR-029).
    for (const w of result.warnings) {
      context.warn(`[${w.kind}] ${w.subject} · ${w.field}: ${w.detail}`);
    }
  } finally {
    await client.end();
  }
}

app.timer('visibleSync', {
  // sec min hour day month day-of-week
  schedule: '0 0 7 * * *',
  runOnStartup: false,
  handler: visibleSync,
});
