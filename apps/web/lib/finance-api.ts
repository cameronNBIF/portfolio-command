'use client';

/**
 * The client's side of `/api/v1/financial` (A7, ADR-031).
 *
 * Thin on purpose. Every rule about what a valid financial row is lives in
 * `packages/api/src/write/financial.ts`, and this file's job is to carry the
 * form's values there and bring the error message back intact. A second copy of
 * the validation here would be a second thing to keep in step, and the copy
 * that drifts is always the one the user sees.
 *
 * AMOUNTS ARE DOLLARS, AS TYPED, AS STRINGS. Not `$M`, and never parsed into a
 * number on the way through -- what Finance typed is what reaches `numeric`.
 * See the units note in `write/financial.ts` for why this path diverges from the
 * export contract.
 */
import type {
  ChangeLogEntry,
  FmvReview,
  FundCommitmentRow,
  LpNavRow,
  ReviewQueueRow,
  TransactionPage,
  ValuationMarkRow,
} from '@portfolio-command/api';

export type FinancialTableName =
  | 'transaction'
  | 'valuation_mark'
  | 'fund_investment_nav'
  | 'fund_distribution'
  | 'fund_commitment';

/** Raised with the server's own message, so the form can show it verbatim. */
export class FinanceApiError extends Error {}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) {
    // The API's 400s carry a sentence written for the person reading it; a
    // generic "request failed" would throw that away at the last step.
    throw new FinanceApiError(body?.error ?? `Request failed (${res.status}).`);
  }
  return body as T;
}

export const fetchTransactions = (params: Record<string, string>): Promise<TransactionPage> =>
  call(`/api/v1/financial?${new URLSearchParams(params)}`);

export const fetchMarks = (params: Record<string, string>): Promise<{ rows: ValuationMarkRow[] }> =>
  call(`/api/v1/financial?${new URLSearchParams({ ...params, table: 'valuation_mark' })}`);

export const fetchLpNav = (params: Record<string, string>): Promise<{ rows: LpNavRow[] }> =>
  call(`/api/v1/financial?${new URLSearchParams({ ...params, table: 'fund_investment_nav' })}`);

/** F5, ADR-037. The commitment ledger: levels as at dates, newest first. */
export const fetchCommitments = (
  params: Record<string, string>,
): Promise<{ rows: FundCommitmentRow[] }> =>
  call(`/api/v1/financial?${new URLSearchParams({ ...params, table: 'fund_commitment' })}`);

export const fetchHistory = (table: string, recordId: string): Promise<{ entries: ChangeLogEntry[] }> =>
  call(`/api/v1/financial/history?${new URLSearchParams({ table, recordId })}`);

/** F2, FR-19. The review cycle as a list Finance can work down. */
export const fetchReviewQueue = (asOf: string): Promise<{ rows: ReviewQueueRow[] }> =>
  call(`/api/v1/financial?${new URLSearchParams({ review: 'queue', asOf })}`);

/** F2, FR-19. Everything a reviewer would otherwise look up, for one company. */
export const fetchReview = (companyId: string, asOf: string): Promise<FmvReview> =>
  call(`/api/v1/financial?${new URLSearchParams({ review: companyId, asOf })}`);

/**
 * The valuation cycle a date falls in: the most recent 31 January or 31 July on
 * or before it (ADR-007).
 *
 * A DEFAULT FOR THE PICKER, NOT A SUBSTITUTE FOR ONE. The API requires `asOf`
 * and refuses to assume today, because a screen that shows different work
 * depending on when it was opened is the drift ADR-021 removed. What this does
 * is spare Finance from typing the date they are almost always going to want —
 * and because the exercise is reported two to three months after its effective
 * date, that is usually the cycle just gone rather than the one approaching.
 */
export function currentValuationCycle(today = new Date()): string {
  const y = today.getUTCFullYear();
  const md = `${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
  if (md >= '07-31') return `${y}-07-31`;
  if (md >= '01-31') return `${y}-01-31`;
  return `${y - 1}-07-31`;
}

/** The retention factor as the sentence Finance uses. "0.7500" -> "75% retained, a 25% decrease". */
export function retentionSentence(factor: string | null): string {
  if (!factor) return '—';
  const retained = Math.round(Number(factor) * 100);
  return retained === 100
    ? 'Reviewed, held at 100%'
    : `Retained ${retained}% — a ${100 - retained}% decrease`;
}

export interface MutationResult {
  ok: true;
  id: string;
  /** True when this change moved a figure inside an already-issued period. */
  restated: boolean;
  /**
   * F2, ADR-034. Present on a review: what the SERVER computed and stored.
   *
   * Reported back rather than assumed, so the screen can say the figure that
   * actually landed instead of the one it previewed. The two agree; echoing the
   * stored one is what makes that checkable from the interface.
   */
  mark?: {
    fmv: string;
    basisFmv: string;
    basisMarkId: string | null;
    retentionFactor: string;
  };
  /**
   * F5, ADR-037 clause 5. The write SUCCEEDED and left the position drawn
   * beyond the commitment in force.
   *
   * Never an error, and the screen must not present it as one: the row is
   * saved. It is a real state of real data — a recallable distribution redrawn,
   * a side letter that has not been keyed yet — and the platform's job is to
   * surface it rather than make it un-recordable.
   */
  overdrawn?: {
    fundInvestmentId: string;
    committed: string | null;
    drawn: string;
  };
}

export function mutate(body: {
  table: FinancialTableName;
  op: 'create' | 'update' | 'delete' | 'restore';
  id?: string;
  values?: unknown;
  reason?: string | null;
}): Promise<MutationResult> {
  return call('/api/v1/financial', { method: 'POST', body: JSON.stringify(body) });
}

/** Dollars for display. The value stays a string; only the rendering changes. */
export function money(dollars: string | null | undefined): string {
  if (dollars === null || dollars === undefined || dollars === '') return '—';
  const n = Number(dollars);
  if (!Number.isFinite(n)) return dollars;
  return n.toLocaleString('en-CA', {
    style: 'currency',
    currency: 'CAD',
    maximumFractionDigits: 0,
  });
}

/**
 * Transaction types, with the labels Finance uses rather than the enum spelling.
 *
 * The LP three are NBIF's own words, confirmed with Funke (FR-33, Q-23), and
 * they are also the STORED values — migration 0012 renamed the enum rather than
 * papering a label over `capital_call`. From the GP's side a drawdown is a
 * capital call; from ours it is a draw against a commitment we already made.
 */
export const TXN_TYPE_LABELS: Record<string, string> = {
  investment: 'Initial investment',
  follow_on: 'Follow-on',
  realization: 'Realization',
  write_off: 'Write-off',
  capital_drawdown: 'Capital Drawdown',
  capital_distribution: 'Capital Distribution',
  fee: 'Fee',
};

/** Which subject a transaction type attaches to. Mirrors the DDL check constraints. */
export const DIRECT_TXN_TYPES = ['investment', 'follow_on', 'realization', 'write_off'];

/**
 * The types that are OUR CHEQUE INTO A ROUND, which is a narrower question than
 * "is this a direct transaction".
 *
 * The same two values are the predicate in `v_round_leverage`, in the export
 * adapter's per-round `invested` lateral, and in `readCompanyCheques`. A
 * realization or a write-off is a direct transaction and can legally carry a
 * round link, but neither funds a round — so neither is ever MISSING one, and
 * neither belongs in a chasing list.
 *
 * Getting this wrong is not cosmetic: the F1 screens flag an unlinked cheque
 * nobody has reviewed, and flagging every write-off would put thirty permanent
 * false targets into the exact count `standalone_confirmed_at` exists to let
 * reach zero (ADR-033 clause 4).
 */
export const ROUND_TXN_TYPES = ['investment', 'follow_on'];
