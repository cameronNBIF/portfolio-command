'use client';

/**
 * The client's side of `/api/v1/rounds` (A8, ADR-012).
 *
 * Thin, for the same reason `finance-api.ts` is thin: every rule about what a
 * valid round is lives in `packages/api/src/write/rounds.ts`, and this file's
 * job is to carry the form's values there and bring the error message back
 * intact. A second copy of the validation here would be a second thing to keep
 * in step, and the copy that drifts is always the one the user sees.
 *
 * AMOUNTS ARE DOLLARS, AS TYPED, AS STRINGS. Not `$M`, and never parsed into a
 * number on the way through — what the deal lead typed is what reaches
 * `numeric`.
 */
import type {
  MandateCompleteness,
  ReferenceData,
  RoundPage,
} from '@portfolio-command/api';

/** Raised with the server's own message, so the form can show it verbatim. */
export class RoundsApiError extends Error {}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) {
    throw new RoundsApiError(body?.error ?? `Request failed (${res.status}).`);
  }
  return body as T;
}

export const fetchRounds = (params: Record<string, string>): Promise<RoundPage> =>
  call(`/api/v1/rounds?${new URLSearchParams(params)}`);

export const fetchCompleteness = (): Promise<MandateCompleteness> =>
  call('/api/v1/rounds?completeness=true');

export const fetchReference = (): Promise<ReferenceData> =>
  call('/api/v1/rounds?reference=true');

export interface RoundMutationResult {
  ok: true;
  id: string;
  restated: boolean;
  coinvestors: { created: number; updated: number; removed: number };
  ownershipWritten: boolean;
}

export function captureRound(body: {
  op: 'create' | 'update' | 'delete' | 'restore';
  id?: string;
  values?: unknown;
  reason?: string | null;
}): Promise<RoundMutationResult> {
  return call('/api/v1/rounds', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * Percent for display. The value stays a string end to end; only the rendering
 * changes. Two decimals because `ownership_after_pct` is stored at
 * numeric(19,16) to satisfy the ADR-001 round trip, and rendering sixteen of
 * them would suggest a cap-table precision nobody has.
 */
export function pct(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return `${n.toFixed(2).replace(/\.00$/, '')}%`;
}
