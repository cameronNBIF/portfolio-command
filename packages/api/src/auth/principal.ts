/**
 * The authorisation model.
 *
 * ADR-005: staff only, four roles, no row-level security and no guest
 * lifecycle. Authorisation reduces to role checks, which is why this file is
 * short and why it should stay short.
 *
 * WHERE ROLES LIVE, and why it matters: in `app_user.role`, not in an Entra
 * app-role claim. Entra proves WHO someone is; the platform decides WHAT they
 * may do. Three consequences, all of them wanted:
 *
 *   - The Azure app registration needs only sign-in configured. No app roles,
 *     no role assignments, no directory admin in the loop to change someone
 *     from `vc` to `finance`.
 *   - `audit_log.changed_by` references the same `app_user` row the check was
 *     made against, so "who was allowed to do this" and "who did it" cannot
 *     drift apart.
 *   - Revoking access is a database update, available to whoever is holding
 *     the pager at 9pm, rather than a tenant change.
 */

/** The four roles from ADR-005. */
export type Role = 'vc' | 'finance' | 'leadership' | 'admin';

export const ROLES: readonly Role[] = ['vc', 'finance', 'leadership', 'admin'] as const;

export interface Principal {
  userId: string;
  entraObjectId: string;
  email: string;
  displayName: string;
  role: Role;
}

/** Thrown when a caller is authenticated but not permitted. Maps to HTTP 403. */
export class ForbiddenError extends Error {
  constructor(readonly required: readonly Role[], readonly actual: Role) {
    super(`Requires one of [${required.join(', ')}]; caller holds "${actual}".`);
    this.name = 'ForbiddenError';
  }
}

/** Thrown when there is no valid caller at all. Maps to HTTP 401. */
export class UnauthorizedError extends Error {
  constructor(message = 'Authentication required.') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Everyone who may read the portfolio.
 *
 * All four roles, deliberately: ADR-005 gives leadership read-all and issues no
 * accounts below that. Narrowing reads is not a thing the platform does, and a
 * list that happens to contain everyone is clearer than an absent check that a
 * reader has to infer was intentional.
 */
export const CAN_READ: readonly Role[] = ROLES;

/**
 * Who may edit judgement records -- health, flags, milestones, covenants,
 * reserves, board seats, memos, diligence gates (ADR-018).
 *
 * Finance is excluded on purpose. The ADR-005 split follows the source of
 * record: Finance owns transactions and valuation marks, the investment team
 * owns judgement. Leadership reads.
 */
export const CAN_EDIT_JUDGEMENT: readonly Role[] = ['vc', 'admin'];

/**
 * Who may write financial rows -- transactions, valuation marks, LP cashflows.
 *
 * Not reachable at A3: the write path exposes judgement fields only, and
 * financial entry arrives at A7 with the ADR-018 Reverse and Correct actions
 * rather than an Edit button. Declared here so the boundary is visible from the
 * authorisation model rather than only from the absence of an endpoint.
 */
export const CAN_WRITE_FINANCIAL: readonly Role[] = ['finance', 'admin'];

/**
 * Who may capture the deal-close mandate fields -- round total, co-investors
 * with their NB flag and amounts, ownership after the round, pro-rata rights
 * and post-money (ADR-012, A8).
 *
 * WHY THIS IS NOT `CAN_WRITE_FINANCIAL`, THOUGH IT WRITES TO TWO OF THE SAME
 * ADR-031 VERSIONED TABLES. The split follows the source of record, exactly as
 * it does above and in `CAN_EDIT_JUDGEMENT`. Our cheque is Finance's fact and
 * lives on `transaction`, which is unchanged and still finance-only. What
 * `investment_round`, `round_coinvestor` and `company_ownership` hold is the
 * shape of the round around that cheque -- who else was in it, how much they
 * put in, what we ended up owning -- and ADR-012 assigns exactly that to the
 * deal lead, at close, from the closing documents they are the one holding.
 *
 * Finance keeps write access because A13 loads Finance's own historical rounds
 * through this path, and a backfill that cannot be corrected by the person
 * running it is a backfill that stalls.
 *
 * Leadership is excluded, per ADR-005: leadership reads.
 */
export const CAN_CAPTURE_ROUND: readonly Role[] = ['vc', 'finance', 'admin'];

/**
 * Who may set a finance policy -- the significant-influence threshold, and the
 * retention options the FMV review offers (F3, FR-21, ADR-035 clause 5).
 *
 * THE SAME TWO ROLES AS `CAN_WRITE_FINANCIAL`, AND STILL A SEPARATE LIST. What
 * this gates is not a financial row: it is a rule that decides how every row is
 * classified, and the two answer different questions -- "who may record what we
 * paid" and "who may decide what counts as significant influence". They coincide
 * today because Finance owns both; a list that happens to equal another is
 * clearer than an alias that hides the day they stop being the same, which is
 * the argument already made on `CAN_READ`.
 *
 * The VC roles are excluded even though `CAN_EDIT_JUDGEMENT` lets them configure
 * the ALERT policy on the same screen. That is deliberate and it is the whole
 * reason the Policies tab has two role-gated sections rather than one: an alert
 * threshold changes a watchlist, and this changes financial-statement treatment.
 */
export const CAN_SET_FINANCE_POLICY: readonly Role[] = ['finance', 'admin'];

export function requireRole(principal: Principal, allowed: readonly Role[]): void {
  if (!allowed.includes(principal.role)) throw new ForbiddenError(allowed, principal.role);
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
