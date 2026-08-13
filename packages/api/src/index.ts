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
  type Principal,
  type Role,
} from './auth/principal.js';
export { resolvePrincipal, authMode, type AuthMode } from './auth/resolve.js';

export { recordAudit, type AuditEntry } from './write/audit.js';
export { applyJudgementEdit, type JudgementEdit } from './write/judgement.js';
