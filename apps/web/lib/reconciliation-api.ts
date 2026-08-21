'use client';

/**
 * The client's side of `/api/v1/reconciliation` (F6, FR-09).
 *
 * Read-only, and there is no mutate here because there is no mutation. Rows
 * leave the list when the fact behind them is corrected on the screen that owns
 * it; a resolve call would be a way to make a row disappear without changing
 * anything, which is the one thing that would make this surface untrustworthy.
 */
import type { ReconciliationReport } from '@portfolio-command/api';

export class ReconciliationApiError extends Error {}

export async function fetchReconciliation(check = 'all'): Promise<ReconciliationReport> {
  const res = await fetch(`/api/v1/reconciliation?${new URLSearchParams({ check })}`, {
    headers: { 'content-type': 'application/json' },
  });
  const body = (await res.json().catch(() => null)) as (ReconciliationReport & { error?: string }) | null;
  if (!res.ok) throw new ReconciliationApiError(body?.error ?? `Request failed (${res.status}).`);
  return body as ReconciliationReport;
}
