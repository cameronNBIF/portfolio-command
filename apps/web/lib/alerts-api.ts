'use client';

/**
 * The client's side of the A9 surfaces (ADR-032).
 *
 * Everything here posts to `/api/v1/judgement`, which is where risk flags,
 * thresholds, the fund alert policy and acknowledgements all live — they are
 * judgement records under ADR-018, not facts, so they share the endpoint that
 * gates on `CAN_EDIT_JUDGEMENT` and writes `audit_log`.
 *
 * Thin on purpose, for the reason `finance-api.ts` gives: every rule about what
 * a valid threshold or a valid acknowledgement is lives in
 * `packages/api/src/write/judgement.ts`, and a second copy here would be a
 * second thing to keep in step. The copy that drifts is always the one the user
 * sees.
 *
 * ONE THING THIS FILE MUST NOT DO IS COALESCE A NULL. The three threshold
 * states — absent, `null`, `0` — mean leave alone, inherit the fund policy, and
 * disable. A `?? 0` or a `|| null` anywhere on this path would collapse two of
 * them and take away either the inheritance or the opt-out. The rule is
 * asserted in `packages/api/test/request-parsing.test.ts`, over the parser this
 * file posts to.
 */
import { call } from './http';

const post = (body: unknown): Promise<void> =>
  call('/api/v1/judgement', { method: 'POST', body: JSON.stringify(body) });

export interface ThresholdInput {
  minRunwayMo?: number | null;
  maxBurnMult?: number | null;
  /** $M. */
  minCashBalance?: number | null;
  maxRevenueDeclinePct?: number | null;
  minNrrPct?: number | null;
}

export const raiseRiskFlag = (input: {
  companyId: string;
  category: string;
  note?: string | null;
  severity?: 'red' | 'yellow' | null;
}): Promise<void> => post({ kind: 'risk-flag-raise', ...input });

export const clearRiskFlag = (flagId: number, reason: string): Promise<void> =>
  post({ kind: 'risk-flag-clear', flagId, reason });

export const setCompanyThresholds = (companyId: string, thresholds: ThresholdInput): Promise<void> =>
  post({ kind: 'company-threshold', companyId, thresholds });

/**
 * Every field is stated. A partial policy would leave the unstated metrics
 * reading whatever the superseded row said, which is not what "this is our
 * policy" means on the screen that sends it.
 */
export const setAlertPolicy = (policy: Required<ThresholdInput> & { note?: string | null }): Promise<void> =>
  post({ kind: 'alert-policy', ...policy });

export const acknowledgeAlert = (input: {
  companyId: string;
  alertKey: string;
  reason: string;
  untilDate: string;
  value?: number | null;
}): Promise<void> => post({ kind: 'alert-acknowledge', ...input });

export const revokeAcknowledgement = (companyId: string, alertKey: string): Promise<void> =>
  post({ kind: 'alert-revoke', companyId, alertKey });

/**
 * The risk-flag vocabulary, mirrored for the picker.
 *
 * A SECOND COPY OF REFERENCE DATA, AND A DELIBERATE ONE. `ref_risk_flag_category`
 * is authoritative and the write path resolves against it — an unknown code is
 * refused there, so this list cannot invent a category. What it can do is go
 * stale, showing one fewer option than the database offers. That is a visible,
 * harmless failure; the alternative is another endpoint and another round trip
 * on a list of fourteen strings that changes about once a year.
 *
 * `suppresses` is shown to the author, because "raising this will replace the
 * runway alert rather than sit beside it" is exactly what someone needs to know
 * before they pick it, and it is the behaviour the old regex hid.
 */
export const RISK_FLAG_CATEGORIES: {
  code: string;
  label: string;
  defaultSeverity: 'red' | 'yellow';
  suppresses?: string;
}[] = [
  { code: 'runway', label: 'Runway', defaultSeverity: 'red', suppresses: 'the runway alert' },
  { code: 'burn', label: 'Burn / cost base', defaultSeverity: 'yellow', suppresses: 'the burn multiple alert' },
  { code: 'covenant', label: 'Covenant', defaultSeverity: 'red' },
  { code: 'financing', label: 'Financing risk', defaultSeverity: 'yellow' },
  { code: 'revenue', label: 'Revenue / plan', defaultSeverity: 'yellow' },
  { code: 'customer-concentration', label: 'Customer concentration', defaultSeverity: 'yellow' },
  { code: 'key-person', label: 'Key person', defaultSeverity: 'red' },
  { code: 'team', label: 'Team / hiring', defaultSeverity: 'yellow' },
  { code: 'market', label: 'Market / competition', defaultSeverity: 'yellow' },
  { code: 'product', label: 'Product / technical', defaultSeverity: 'yellow' },
  { code: 'governance', label: 'Governance', defaultSeverity: 'yellow' },
  { code: 'legal-regulatory', label: 'Legal / regulatory', defaultSeverity: 'yellow' },
  { code: 'gov-funding', label: 'Government funding', defaultSeverity: 'yellow' },
  { code: 'other', label: 'Other', defaultSeverity: 'yellow' },
];
