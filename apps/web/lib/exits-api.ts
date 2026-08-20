'use client';

/**
 * The client's side of `/api/v1/exits` (F4, ADR-036).
 *
 * Thin, for the reason every other client here is thin: what a valid exit event
 * is lives in `packages/api/src/write/exits.ts`, including the vocabulary —
 * which is read from the database constraint, so this file does not carry a
 * copy of it either. The form offers what the server sends.
 *
 * THERE IS NO "MARK EXITED" CALL, and there is not going to be one. Membership
 * follows Affinity's roster status; what this records is the economic event.
 */
import type { ExitedView } from '@portfolio-command/api';

/** Raised with the server's own message, so the form can show it verbatim. */
export class ExitsApiError extends Error {}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ExitsApiError(body?.error ?? `Request failed (${res.status}).`);
  return body as T;
}

export const fetchExitedView = (asOf: string): Promise<ExitedView> =>
  call(`/api/v1/exits?${new URLSearchParams({ asOf })}`);

export interface ExitResult {
  ok: true;
  companyId: string;
  replacedExisting: boolean;
  /** ADR-036 clause 2: the roster still calls this a portfolio company. */
  stillOnRoster: boolean;
}

export const recordExit = (values: {
  companyId: string;
  exitDate: string;
  exitType: string;
  note?: string | null;
}): Promise<ExitResult> =>
  call('/api/v1/exits', { method: 'POST', body: JSON.stringify({ op: 'record', values }) });

export const removeExit = (companyId: string, reason: string): Promise<ExitResult> =>
  call('/api/v1/exits', { method: 'POST', body: JSON.stringify({ op: 'remove', companyId, reason }) });
