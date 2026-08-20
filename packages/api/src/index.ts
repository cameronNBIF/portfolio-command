/**
 * The API layer.
 *
 * Everything a route handler needs, and nothing that knows about HTTP. The
 * Next.js handlers in `apps/web/app/api` are deliberately thin wrappers over
 * this: the logic worth testing is testable without a server, which is what
 * `test/round-trip.test.ts` relies on.
 */
export { db, closeDb } from './db.js';
export { toDollars, toMillions, toNumber, toNumeric } from './units.js';
export { periodOf, toCalendarLabel, type QuarterPeriod } from './periods.js';

export { buildExport, resolveAsOf, type ExportOptions } from './read/export.js';
export { readKpiCoverage, type KpiCoverageRow } from './read/kpi-coverage.js';

// F2, FR-19. The FMV review workspace: a surface rather than a form. Reads
// only -- the proposal panel waits on Q-2 to Q-4 (ADR-034).
export {
  readFmvReview,
  readFmvReviewQueue,
  type FmvReview,
  type ReviewQueueRow,
  type ReviewTransaction,
  type ReviewRound,
  type CurrentValuation,
} from './read/fmv-review.js';
// F3, FR-21/FR-36. The significant-influence schedule and the ownership history
// behind it. The flag is three-valued and NULL is never collapsed to false
// (ADR-035 clause 4).
// F4, FR-29, ADR-036. The Exited view: two facts with two owners, and the
// surface that shows them disagreeing rather than picking a winner.
export {
  readExitedView,
  type ExitedView,
  type ExitRow,
} from './read/exits.js';
export {
  readSignificantInfluence,
  readOwnershipHistory,
  type SignificantInfluenceReport,
  type SignificantInfluenceRow,
  type OwnershipRow,
} from './read/ownership.js';
export {
  readFinancePolicies,
  type FinancePolicies,
  type AccountingPolicyRow,
  type RetentionOptionRow,
} from './read/policies.js';
export {
  readRounds,
  readCompanyCheques,
  readMandateCompleteness,
  readReferenceData,
  type RoundRow,
  type RoundChequeRow,
  type CompanyChequeRow,
  type RoundFilters,
  type RoundPage,
  type CoinvestorRow,
  type MandateCompleteness,
  type ReferenceData,
} from './read/rounds.js';
export { importContract, asOfDate, type ImportResult, type ImportWarning } from './import/import-contract.js';

export {
  requireRole,
  isRole,
  ForbiddenError,
  UnauthorizedError,
  ROLES,
  CAN_READ,
  CAN_EDIT_JUDGEMENT,
  CAN_WRITE_FINANCIAL,
  CAN_CAPTURE_ROUND,
  CAN_SET_FINANCE_POLICY,
  type Principal,
  type Role,
} from './auth/principal.js';
export { resolvePrincipal, authMode, type AuthMode } from './auth/resolve.js';

export {
  readTransactions,
  readValuationMarks,
  readLpNav,
  readRowHistory,
  readRestatements,
  type TransactionRow,
  type TransactionFilters,
  type TransactionPage,
  type ValuationMarkRow,
  type LpNavRow,
  type ChangeLogEntry,
} from './read/finance.js';

export { recordAudit, type AuditEntry } from './write/audit.js';
export { ValidationError } from './write/errors.js';
export { applyJudgementEdit, type JudgementEdit } from './write/judgement.js';

// ADR-031. Financial rows are editable over a versioned store; ADR-018's
// append-only interface is superseded. Version capture is a database trigger,
// not anything exported here.
export {
  applyFinancialMutation,
  type FinancialMutation,
  type FinancialTable,
  type FinancialWriteResult,
  type TransactionInput,
  type ValuationMarkInput,
  type MarkAdjustmentType,
  type LpNavInput,
  type FundDistributionInput,
} from './write/financial.js';

// ADR-012, A8. The deal-close capture: one mutation, three tables, written by
// the deal lead rather than by Finance (CAN_CAPTURE_ROUND).
// ADR-033, F1. The cheque-to-round link: one narrow mutation, both surfaces,
// gated on CAN_CAPTURE_ROUND because it can move a foreign key and nothing else.
export {
  applyLinkTransactions,
  type LinkTransactionsMutation,
  type LinkTransactionsResult,
} from './write/link-transactions.js';

// F3, FR-36, ADR-035. Ownership maintained between rounds: one table, one
// mutation, `CAN_CAPTURE_ROUND` because that is where the table already sits.
export {
  applyOwnershipMutation,
  type OwnershipMutation,
  type OwnershipAdjustmentInput,
  type OwnershipWriteResult,
} from './write/ownership.js';

// F4, S-4, FR-28. The exit event -- Finance's economic fact. It does NOT move
// the company between views; membership follows the Affinity roster (ADR-036).
export {
  applyExitMutation,
  type ExitMutation,
  type ExitEventInput,
  type ExitWriteResult,
} from './write/exits.js';

// F3, FR-21, ADR-035 clause 5. The finance policies, behind their own gate:
// what this sets is not a financial row but the rule that classifies every one.
export {
  applyFinancePolicyEdit,
  type FinancePolicyEdit,
  type FinancePolicyResult,
} from './write/finance-policy.js';

export {
  applyRoundMutation,
  type RoundMutation,
  type RoundCaptureInput,
  type CoinvestorInput,
  type OwnershipInput,
  type RoundWriteResult,
} from './write/rounds.js';
