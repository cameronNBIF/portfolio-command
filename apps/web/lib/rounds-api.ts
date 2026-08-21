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
  CompanyChequeRow,
  MandateCompleteness,
  ReferenceData,
  RoundPage,
} from '@portfolio-command/api';

import { call } from './http';

export const fetchRounds = (params: Record<string, string>): Promise<RoundPage> =>
  call(`/api/v1/rounds?${new URLSearchParams(params)}`);

export const fetchCompleteness = (): Promise<MandateCompleteness> =>
  call('/api/v1/rounds?completeness=true');

export const fetchReference = (): Promise<ReferenceData> =>
  call('/api/v1/rounds?reference=true');

/** F1. Every direct cheque a company has, with the round each is attached to. */
export const fetchCompanyCheques = (companyId: string): Promise<{ rows: CompanyChequeRow[] }> =>
  call(`/api/v1/rounds?${new URLSearchParams({ cheques: companyId })}`);

export interface RoundMutationResult {
  ok: true;
  id: string;
  restated: boolean;
  coinvestors: { created: number; updated: number; removed: number };
  ownershipWritten: boolean;
}

export interface LinkResult {
  ok: true;
  linked: number;
  cleared: number;
  restated: boolean;
  participationSetToYes: boolean;
}

/**
 * ADR-033's narrow mutation, from either surface.
 *
 * ON `/api/v1/rounds` RATHER THAN `/api/v1/financial`, though it writes a
 * column on `transaction`. The gate is `CAN_CAPTURE_ROUND`, because attaching a
 * cheque to a round is reconciliation rather than restatement — and the deal
 * lead who closed the round is `vc`, who cannot reach the financial endpoint at
 * all.
 *
 * `investmentRoundId: null` is the explicit *No round — standalone* choice, and
 * it is a WRITE, not an absence: it records who confirmed it and when.
 */
export function linkTransactions(body: {
  transactionIds: string[];
  investmentRoundId: string | null;
  reason?: string | null;
}): Promise<LinkResult> {
  return call('/api/v1/rounds', {
    method: 'POST',
    body: JSON.stringify({ op: 'link-transactions', ...body }),
  });
}

export function captureRound(body: {
  op: 'create' | 'update' | 'delete' | 'restore';
  id?: string;
  values?: unknown;
  reason?: string | null;
  /** F6, FR-08. Sent only on the retry, after the warning has been shown. */
  duplicateAckReason?: string | null;
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
