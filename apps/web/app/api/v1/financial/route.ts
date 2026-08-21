/**
 * `POST /api/v1/financial` — create, edit, delete and restore financial rows.
 *
 * The endpoint the note in `judgement/route.ts` said would not exist. It exists
 * because ADR-031 superseded ADR-018: rows are editable, and the reproducibility
 * ADR-018 was defending is kept by the versioned store underneath rather than by
 * withholding the verb. See ADR-031 before widening anything here.
 *
 * `GET` serves the transaction table the Finance tab renders.
 *
 * AMOUNTS ARE DOLLARS ON THIS ENDPOINT, as text, not the contract's `$M`. See
 * the units note at the top of `packages/api/src/write/financial.ts` — it is a
 * deliberate divergence from the export contract and the reasoning matters.
 *
 * THE BODY PARSER IS NOT HERE ANY MORE. `parseFinancialMutation` sits beside
 * `applyFinancialMutation`, which owns the field rules the envelope has to stay
 * in step with, and is tested without a server — see `write/parse.ts`.
 */
import {
  applyFinancialMutation,
  db,
  parseFinancialMutation,
  readFmvReview,
  readFmvReviewQueue,
  readFundCommitments,
  readLpNav,
  readTransactions,
  readValuationMarks,
  ValidationError,
} from '@portfolio-command/api';

import { jsonBody, withPrincipal } from '../../_lib/handler';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return withPrincipal(request, async (principal) => {
    const mutation = parseFinancialMutation(await jsonBody(request));
    // The role check lives in applyFinancialMutation so a second caller that
    // does not come through this route cannot skip it.
    const result = await applyFinancialMutation(db(), principal, mutation);
    return { ok: true, ...result };
  });
}

/**
 * `?table=` chooses the surface. Transactions are the default because they are
 * the table Finance spends its time in; marks and LP NAV return plain arrays
 * because neither is large enough to page or to need running totals.
 */
export async function GET(request: Request): Promise<Response> {
  return withPrincipal(request, async (principal) => {
    const q = new URL(request.url).searchParams;
    const includeDeleted = q.get('includeDeleted') === 'true';

    /**
     * F2, FR-19. The review workspace.
     *
     * On the financial endpoint rather than a route of its own because it is
     * the read behind Finance's own screen and shares its gate. `asOf` is
     * REQUIRED, not defaulted to today: the cycle date is 31 January or 31 July
     * (ADR-007), and a default would make the same screen show different work
     * depending on when it was opened -- the drift ADR-021 exists to prevent.
     */
    const reviewAsOf = q.get('asOf');
    if (q.get('review') === 'queue') {
      if (!reviewAsOf) throw new ValidationError('"asOf" is required — the review cycle date, as YYYY-MM-DD.');
      return { rows: await readFmvReviewQueue(db(), principal, reviewAsOf) };
    }
    const reviewCompany = q.get('review');
    if (reviewCompany) {
      if (!reviewAsOf) throw new ValidationError('"asOf" is required — the review cycle date, as YYYY-MM-DD.');
      return readFmvReview(db(), principal, reviewCompany, reviewAsOf);
    }

    if (q.get('table') === 'valuation_mark') {
      return { rows: await readValuationMarks(db(), principal, {
        companyId: q.get('companyId'), includeDeleted,
      }) };
    }
    if (q.get('table') === 'fund_investment_nav') {
      return { rows: await readLpNav(db(), principal, {
        fundInvestmentId: q.get('fundInvestmentId'), includeDeleted,
      }) };
    }
    if (q.get('table') === 'fund_commitment') {
      return { rows: await readFundCommitments(db(), principal, {
        fundInvestmentId: q.get('fundInvestmentId'), includeDeleted,
      }) };
    }

    return readTransactions(db(), principal, {
      companyId: q.get('companyId'),
      fundInvestmentId: q.get('fundInvestmentId'),
      txnType: q.get('txnType'),
      from: q.get('from'),
      to: q.get('to'),
      includeDeleted,
      limit: q.has('limit') ? Number(q.get('limit')) : undefined,
      offset: q.has('offset') ? Number(q.get('offset')) : undefined,
    });
  });
}
