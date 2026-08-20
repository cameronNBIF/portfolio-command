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
  LpNavRow,
  TransactionPage,
  ValuationMarkRow,
} from '@portfolio-command/api';

export type FinancialTableName =
  | 'transaction'
  | 'valuation_mark'
  | 'fund_investment_nav'
  | 'fund_distribution';

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

export const fetchHistory = (table: string, recordId: string): Promise<{ entries: ChangeLogEntry[] }> =>
  call(`/api/v1/financial/history?${new URLSearchParams({ table, recordId })}`);

export interface MutationResult {
  ok: true;
  id: string;
  /** True when this change moved a figure inside an already-issued period. */
  restated: boolean;
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

/** Transaction types, with the labels Finance uses rather than the enum spelling. */
export const TXN_TYPE_LABELS: Record<string, string> = {
  investment: 'Initial investment',
  follow_on: 'Follow-on',
  realization: 'Realization',
  write_off: 'Write-off',
  capital_call: 'Capital call',
  distribution: 'Distribution',
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
