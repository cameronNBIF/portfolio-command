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
 */
import {
  applyFinancialMutation,
  db,
  readFmvReview,
  readFmvReviewQueue,
  readLpNav,
  readTransactions,
  readValuationMarks,
  ValidationError,
  type FinancialMutation,
} from '@portfolio-command/api';

import { withPrincipal } from '../../_lib/handler';

export const dynamic = 'force-dynamic';

const TABLES = ['transaction', 'valuation_mark', 'fund_investment_nav', 'fund_distribution'];
const OPS = ['create', 'update', 'delete', 'restore'];

/**
 * Narrows the body to a `FinancialMutation`.
 *
 * Shallow on purpose: this checks the envelope — table, op, and that an id is
 * present when one is needed — and leaves every field rule to
 * `applyFinancialMutation`, which owns them and raises the same error type. Two
 * validators over the same fields is how the two drift apart.
 */
function parseMutation(body: unknown): FinancialMutation {
  if (typeof body !== 'object' || body === null) throw new ValidationError('Body must be an object.');
  const b = body as Record<string, unknown>;

  const table = b['table'];
  if (typeof table !== 'string' || !TABLES.includes(table)) {
    throw new ValidationError(
      `"table" must be one of: ${TABLES.join(', ')}. ` +
        'Judgement records are edited through /api/v1/judgement.',
    );
  }
  const op = b['op'];
  if (typeof op !== 'string' || !OPS.includes(op)) {
    throw new ValidationError(`"op" must be one of: ${OPS.join(', ')}.`);
  }

  const reason = typeof b['reason'] === 'string' ? b['reason'] : null;

  if (op === 'delete' || op === 'restore') {
    const id = b['id'];
    if (typeof id !== 'string' || !/^\d+$/.test(id)) {
      throw new ValidationError('"id" is required and must be a row id.');
    }
    return { table, op, id, reason } as FinancialMutation;
  }

  const values = b['values'];
  if (typeof values !== 'object' || values === null) {
    throw new ValidationError('"values" must be an object holding the complete row.');
  }
  if (op === 'update') {
    const id = b['id'];
    if (typeof id !== 'string' || !/^\d+$/.test(id)) {
      throw new ValidationError('"id" is required on an update and must be a row id.');
    }
    return { table, op, id, values, reason } as FinancialMutation;
  }
  return { table, op, values, reason } as FinancialMutation;
}

export async function POST(request: Request): Promise<Response> {
  return withPrincipal(request, async (principal) => {
    const mutation = parseMutation(await request.json().catch(() => null));
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
