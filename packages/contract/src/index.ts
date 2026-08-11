/**
 * The ADR-001 export contract.
 *
 * This is the shape `GET /api/v1/export` emits, the shape `docs/reference/
 * demo.json` holds, and the only shape `packages/metrics` ever sees (ADR-021).
 * Types and nothing else -- no runtime code, no I/O, no dependencies.
 *
 * CONVENTIONS, and they are load-bearing:
 *   - Money is **$M** as a plain number. The database stores dollars as
 *     numeric(18,2) (ADR-008); the API layer converts in exactly one place on
 *     the way out, and that place is the only one (ADR-001, ADR-021).
 *   - Percentages are plain numbers: 11.2 means 11.2%, not 0.112.
 *   - Dates are `YYYY-MM-DD` strings.
 *   - Quarter labels are strings like `2026-Q1`. Which convention they carry --
 *     fiscal or calendar -- is chosen per endpoint and stated on screen
 *     (ADR-006, D-6). Nothing here keys, joins or sorts on one.
 *
 * `schemaVersion` is 1 and changes only when the CONTRACT changes. Storage
 * changes underneath do not bump it.
 */

/** A quarterly point on the fund's NAV history. Drives the FMV growth KPIs. */
export interface NavHistoryPoint {
  q: string;
  nav: number;
  cost: number;
}

/** A realization at fund level. Distinct from `Company.realized` -- see note on Fund. */
export interface FundDistribution {
  date: string;
  amount: number;
  company: string;
  note: string;
}

/**
 * Fund-level facts.
 *
 * NOTE: `distributions[]` and the sum of `Company.realized` are independent
 * representations of the same events and do not have to agree -- on the
 * reference dataset they differ by $5.5M. The prototype uses `distributions[]`
 * for TVPI/DPI and `Company.realized` for MOIC, and the port reproduces that
 * exactly (ADR-013). ADR-002 removes the divergence at the storage layer by
 * deriving both from one transaction table; it does not change the definitions.
 */
export interface Fund {
  name: string;
  currency: string;
  /** Inception year. */
  vintage: number;
  /** Switches framing app-wide: evergreen keeps TVPI/DPI/RVPI but labels them since-inception. */
  style: 'evergreen' | 'closed-end';
  /** $M permanent capital (evergreen). */
  capitalBase: number;
  /** $M (closed-end framing). */
  committed: number;
  called: number;
  distributionPolicy: string;
  /** Percentage points subtracted from gross IRR to estimate net. Labelled an estimate on screen. */
  feeDragPct: number;
  navHistory: NavHistoryPoint[];
  annualPlatformTarget: number;
  annualFollowOnBudget: number;
  ytdPlatformsClosed: number;
  reservesPolicy: string;
  distributions: FundDistribution[];
}

/**
 * One financing round we participated in.
 *
 * `roundTotal` and `nbOther` are OPTIONAL and that is the point. ADR-012
 * captures them at deal close and historical rounds will have gaps that no
 * process can now fill. The contract carries every round UNFILTERED, including
 * those with a missing or invalid total, and `packages/metrics` applies the
 * leverage exclusion itself -- because that predicate is the frozen definition
 * (ADR-021, ADR-023). A round is never imputed.
 */
export interface Round {
  date: string;
  label: string;
  instrument: string;
  /** Our cheque, $M. */
  invested: number;
  /** Whole round size, $M. Absent where it was never captured. Drives leverage. */
  roundTotal?: number | null;
  /** $M from other New Brunswick investors, excluding us. Drives NB co-investment. */
  nbOther?: number | null;
  /** Null for SAFE and convertible note. */
  postMoney?: number | null;
  ownershipAfter: number;
  lead: string;
  note: string;
}

/**
 * A quarterly KPI period as reported through Visible.
 *
 * `revenue` is the PERIOD ACTUAL, not a run-rate, and is stored and displayed
 * as reported with no annualisation (D-2, ADR-010). The prototype's on-screen
 * label said run-rate; the arithmetic was always the actual.
 *
 * ORDERING IS LOAD-BEARING: metrics read `kpis[0]` as the most recent period
 * and `kpis[1]` as the one before. Nothing sorts this array -- the producer
 * must emit it newest-first. See INHERITED-COERCIONS.md §3.
 */
export interface Kpi {
  period: string;
  revenue: number;
  /** Monthly burn, $M. Negative means cash-flow positive. */
  burn: number;
  cash: number;
  runwayMo: number;
}

export interface ValuationMark {
  date: string;
  fmv: number;
  method: string;
  by: string;
  rationale: string;
}

export interface BoardPosition {
  seat: 'Director' | 'Observer' | 'None' | string;
  holder: string;
  nextMeeting?: string | null;
}

/** Alert thresholds. `minRunwayMo` is absent on some records; a value of 0 disables the alert. */
export interface Thresholds {
  minRunwayMo?: number;
  maxBurnMult?: number;
}

export interface Milestone {
  title: string;
  due: string;
  status: 'on-track' | 'at-risk' | 'pending' | string;
}

export interface Covenant {
  text: string;
  status: string;
}

export interface GovFunding {
  program: string;
  amount: number;
  conditions: string;
  status: string;
}

export interface CompanyTask {
  title: string;
  due: string;
  done: boolean;
}

/**
 * A direct portfolio company.
 *
 * ORDERING IS LOAD-BEARING and runs the OPPOSITE way to `kpis`: `rounds[0]` is
 * read as the FIRST round chronologically (suggestedReserve's initial cheque).
 * Emit rounds oldest-first and KPIs newest-first. See INHERITED-COERCIONS.md §3.
 */
export interface Company {
  id: string;
  name: string;
  sector: string;
  stage: string;
  vintage: number;
  health: 'green' | 'yellow' | 'red' | string;
  instrument: string;
  ownershipPct: number;
  /** All $M. Derived from transactions under ADR-002; scalars here are the serialised result. */
  invested: number;
  fmv: number;
  realized: number;
  exited: boolean;
  exitDate?: string;
  exitType?: string;
  ceo: string;
  hq: string;
  desc: string;
  riskFlags: string[];
  proRata: boolean;
  reservesAllocated: number;
  reservesDeployed: number;
  board: BoardPosition;
  /** Newest first. */
  kpis: Kpi[];
  thresholds: Thresholds;
  /** Oldest first. */
  rounds: Round[];
  milestones: Milestone[];
  covenants: Covenant[];
  govFunding?: GovFunding | null;
  marks: ValuationMark[];
  tasks: CompanyTask[];
  fteAtEntry: number;
  fte: number;
  fteNB: number;
  /**
   * Diversity. NULL means NOT REPORTED and must never render as zero (D-5,
   * ADR-010): "0% of companies have women in the C-suite" when the truth is
   * "not asked" is a materially worse error than reporting nothing. The
   * prototype coerces null to 0; the sanctioned departure excludes
   * non-reporters from the denominator and shows coverage alongside.
   */
  womenCSuite?: number | null;
  cSuiteSize?: number | null;
  source: string;
  /**
   * Accelerator position (Affinity Risk Assessment `ACC`). Absent in the
   * prototype, which has no ACC concept -- so `includeAccelerator: true`
   * reproduces it exactly and is the only golden-mastered path (ADR-013,
   * ADR-022).
   */
  isAccelerator?: boolean;
}

export interface DealGate {
  name: string;
  status: 'pending' | 'in-progress' | 'passed' | 'failed' | string;
}

export interface TermSheet {
  security: string;
  preMoney: number;
  postMoney: number;
  investment: number;
  ownership: number;
  liquidation: string;
  antiDilution: string;
  board: string;
  proRata: string;
  dividends: string;
  optionPool: string;
  founderVesting: string;
}

export interface PipelineDeal {
  id: string;
  name: string;
  sector: string;
  funnel: 'Sourced' | 'Screening' | 'Diligence' | 'IC Review' | 'Term Sheet' | 'Closed' | 'Passed' | string;
  source: string;
  checkSize: number;
  valuation: number;
  owner: string;
  nextStep: string;
  added: string;
  closedDate?: string;
  gates: DealGate[];
  termSheet?: TermSheet | null;
}

/** Negative is a capital call, positive a distribution. */
export interface LpCashflow {
  date: string;
  amount: number;
}

/**
 * A strategic LP position.
 *
 * NEVER blended with the direct portfolio. LP multiples are on CALLED capital
 * per standard LP convention; direct MOIC is on invested cost. Keeping them
 * apart is a settled product decision, not an oversight.
 */
export interface FundInvestment {
  id: string;
  name: string;
  manager: string;
  strategy: string;
  vintage: number;
  /** All $M. */
  committed: number;
  called: number;
  distributions: number;
  nav: number;
  coInvestRights: boolean;
  coInvestsDone: number;
  referrals: number;
  /** $M this manager and its network put into our direct portfolio. */
  capitalToDirect: number;
  womenSeniorGP: boolean;
  nextCallEst?: string | null;
  agm?: string | null;
  contact: string;
  rationale: string;
  cashflows: LpCashflow[];
}

/** Memo section text, keyed by company or deal id. */
export type Memos = Record<string, Record<string, string>>;

export interface Meta {
  /** Bumps only when the CONTRACT changes, never when storage does. */
  schemaVersion: 1;
  /**
   * Wall-clock stamp. Normalised out of the contract snapshot test, because a
   * timestamp drifting is not contract drift (ADR-022).
   */
  savedAt: string | null;
  demo: boolean;
}

/** The root document. `GET /api/v1/export` emits exactly this. */
export interface PortfolioExport {
  fund: Fund;
  companies: Company[];
  pipeline: PipelineDeal[];
  fundInvestments: FundInvestment[];
  memos: Memos;
  meta: Meta;
}
