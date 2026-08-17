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
export {
  readRounds,
  readMandateCompleteness,
  readReferenceData,
  type RoundRow,
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
  type LpNavInput,
  type FundDistributionInput,
} from './write/financial.js';

// ADR-012, A8. The deal-close capture: one mutation, three tables, written by
// the deal lead rather than by Finance (CAN_CAPTURE_ROUND).
export {
  applyRoundMutation,
  type RoundMutation,
  type RoundCaptureInput,
  type CoinvestorInput,
  type OwnershipInput,
  type RoundWriteResult,
} from './write/rounds.js';
