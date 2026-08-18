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
 * `schemaVersion` changes only when the CONTRACT changes. Storage changes
 * underneath do not bump it. It is at 3; see `Meta.schemaVersion` for what
 * each version added. EVERY ADDITION SINCE 1 IS OPTIONAL, which is not
 * politeness to old consumers — it is what lets `docs/reference/demo.json`
 * stay frozen at 1 (ADR-022) while remaining a valid document that the
 * metrics package reads and the golden master asserts against.
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
  /**
   * Net revenue retention, percent as reported: 107 means 107%. Added at
   * schemaVersion 3 — the column has been in `company_kpi` since A1 and never
   * reached the contract, so it is absent on the reference fixture and the NRR
   * alert simply never evaluates there.
   */
  nrr?: number | null;
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

/**
 * Per-company alert thresholds.
 *
 * THREE MEANINGS, NOT TWO, AND THE DIFFERENCE DECIDES A WATCHLIST:
 *
 *   absent  -- this company sets no threshold of its own. From
 *              schemaVersion 3 it INHERITS `AlertPolicy`; before 3 it
 *              simply had no alert. The reference fixture is
 *              schemaVersion 1 and carries no policy, so the two are
 *              indistinguishable there and the inherited behaviour is
 *              reproduced exactly (ADR-013).
 *   0       -- DISABLED. The company opts out, and the fund policy does
 *              not resurrect it. This is the inherited meaning and it is
 *              the only escape hatch from a portfolio-wide default.
 *   n > 0   -- this company's own threshold, overriding the policy.
 *
 * `minCashBalance` is $M like every other money field in this contract.
 */
export interface Thresholds {
  minRunwayMo?: number;
  maxBurnMult?: number;
  /** Added at schemaVersion 3. $M. */
  minCashBalance?: number;
  /** Added at schemaVersion 3. Percent: 20 means a 20% quarter-over-quarter fall. */
  maxRevenueDeclinePct?: number;
  /** Added at schemaVersion 3. Percent as reported: 90 means 90% net revenue retention. */
  minNrrPct?: number;
}

/**
 * Portfolio-wide alert thresholds, added at schemaVersion 3.
 *
 * The answer to "where does the platform record that our runway
 * threshold is twelve months". Every company that does not set its own
 * threshold for a metric inherits this one.
 *
 * OPTIONAL ON THE DOCUMENT, AND THAT IS LOAD-BEARING. The reference
 * fixture is schemaVersion 1 and will never carry a policy (ADR-022
 * freezes it). A consumer that finds this absent must fall back to
 * per-company thresholds alone, which is precisely the prototype's
 * behaviour -- and is why adding fund defaults did not disturb a single
 * golden-master figure.
 *
 * A null field means the fund sets no policy for that metric. It never
 * means zero.
 */
export interface AlertPolicy {
  minRunwayMo: number | null;
  maxBurnMult: number | null;
  /** $M. */
  minCashBalance: number | null;
  maxRevenueDeclinePct: number | null;
  minNrrPct: number | null;
  /** `YYYY-MM-DD`. When this policy came into force. */
  effectiveFrom: string;
  setBy: string;
  note?: string | null;
}

/**
 * The structured half of a risk flag, added at schemaVersion 3.
 *
 * `Company.riskFlags` keeps emitting display strings and keeps being the
 * field the contract froze. This runs ALONGSIDE it, one entry per flag,
 * in the same order -- the ADR-026 pattern: the verbatim string for the
 * contract, the resolved key for logic.
 *
 * `category` is what replaced de-duplicating flags by regex on their
 * text. A category declares which derived metric alert it stands in
 * for, so a flag about runway suppresses the runway alert because it
 * says it does, not because it contains the word.
 */
export interface RiskFlagDetail {
  id: number;
  /** Stable machine key from `ref_risk_flag_category.code`. */
  category: string;
  categoryLabel: string;
  /** The free-text half, if the author wrote one. */
  note?: string | null;
  /** `null` = inherit the company's health colour, the frozen prototype rule. */
  severity: 'red' | 'yellow' | null;
  /** `YYYY-MM-DD`. */
  raisedAt: string;
  raisedBy: string;
}

/**
 * A time-boxed judgement that an open alert is understood and accepted.
 * Added at schemaVersion 3.
 *
 * Suppresses an alert from the ACTIVE feed. It never deletes one: the
 * breach is still derived, still true, and still shown on the company.
 *
 * `value` is the metric as it stood when this was signed. The alert
 * returns early if the figure moves materially past it, because knowing
 * about four months of runway is not consent to ignore two.
 */
export interface AlertAcknowledgement {
  /** Matches `HealthAlert.key`. Derived from the alert's subject, never its value. */
  alertKey: string;
  reason: string;
  /** `YYYY-MM-DD`. The acknowledgement expires on its own. */
  untilDate: string;
  value: number | null;
  by: string;
  /** `YYYY-MM-DD`. */
  at: string;
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
  /**
   * Affinity's Risk Assessment grade behind `health`, added at schemaVersion 3.
   * A / B / C map to green / yellow / red; ACC marks an accelerator investment
   * and carries no risk grade (ADR-009).
   *
   * WITH `healthSetBy` AND `healthSetAt`, THIS IS THE WHOLE OF WHAT THE
   * PLATFORM OFFERS ON HEALTH. Affinity is the system of record, the sync is
   * one-way, and the VC team maintains the rating there. Showing who set it and
   * when is the useful thing the platform can do; offering an edit box would
   * create a rating that disagrees with itself across two systems.
   */
  riskGrade?: string | null;
  healthSetBy?: string | null;
  /** `YYYY-MM-DD`. */
  healthSetAt?: string | null;
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
  /**
   * The structured half of `riskFlags`, added at schemaVersion 3. Same
   * order, one entry per flag. Absent on the reference fixture, which
   * has display strings and nothing behind them.
   */
  riskFlagDetail?: RiskFlagDetail[];
  /** Open alert acknowledgements. Added at schemaVersion 3. */
  acknowledgements?: AlertAcknowledgement[];
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
  /**
   * The deal's EXACT position in the funnel, not a display bin.
   *
   * From schemaVersion 2 this carries Affinity's own Status vocabulary --
   * "Second Meeting", "With Legal", "Conditional Approval" and thirteen others
   * -- because those are the terms the investment team discusses a deal in, and
   * flattening them would lose a company's position between the two systems
   * (ADR-009). The prototype's seven values below are what the reference
   * fixture carries. Group it for display with `PortfolioExport.funnelGroups`.
   */
  funnel: 'Sourced' | 'Screening' | 'Diligence' | 'IC Review' | 'Term Sheet' | 'Closed' | 'Passed' | string;
  source: string;
  checkSize: number;
  /** Null where the deal has not been priced yet. Never 0 -- that would be a claim, not a gap. */
  valuation: number | null;
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

/**
 * A column on the pipeline board, and the funnel stages that render in it.
 *
 * Added at schemaVersion 2. Affinity carries SIXTEEN funnel statuses and they
 * are the terms the investment team actually speaks, so `PipelineDeal.funnel`
 * is the deal's exact position rather than a bin (ADR-009). Sixteen columns do
 * not fit on a board, so the API also emits this grouping and the board renders
 * from it (ADR-014).
 *
 * It is reference data, so it lives at the document root ONCE rather than being
 * repeated on every deal. Emitting it is what stops the frontend hardcoding a
 * column list that an admin can change with a row edit.
 */
export interface FunnelGroup {
  name: string;
  /**
   * A deal resting here is out of the funnel: Closed, Passed and Watchlist.
   * "Active deals" is the set whose group is not terminal, and reading it from
   * here is what keeps that definition out of a hardcoded name list.
   */
  isTerminal: boolean;
  /**
   * Whether the group gets a kanban column. SEPARATE from `isTerminal`, because
   * the two genuinely differ: Closed is terminal but renders as a column, since
   * a closed deal is an outcome worth seeing; Passed and Watchlist are listed
   * beneath the board so dead and parked deals take no space.
   */
  showOnBoard: boolean;
  /** Stage names rendering in this column, in their own rank order. */
  stages: string[];
}

export interface Meta {
  /**
   * Bumps only when the CONTRACT changes, never when storage does.
   *
   * 1 — the prototype's shape, which `docs/reference/demo.json` holds and
   *     which is frozen (ADR-022): it is that file's own boot state and cannot
   *     be re-exported without invalidating every golden-master fixture.
   * 2 — adds `funnelGroups`. The API emits 2; the reference fixture stays 1,
   *     which is why the field is optional rather than required.
   * 3 — adds `alertPolicy`, three fields to `Thresholds`, and
   *     `riskFlagDetail` / `acknowledgements` on a company (A9, ADR-032).
   *     Every addition is optional for the same reason: the fixture stays
   *     1, and `healthAlerts()` reads the policy only when it is present,
   *     so the frozen fixture produces the frozen figures.
   */
  schemaVersion: 1 | 2 | 3;
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
  /**
   * Board columns for `pipeline`. Present from schemaVersion 2; absent on the
   * reference fixture, which is schemaVersion 1. A consumer that finds it
   * missing should fall back to treating each `funnel` value as its own column.
   */
  funnelGroups?: FunnelGroup[];
  /**
   * Portfolio-wide alert thresholds. Present from schemaVersion 3;
   * absent on the reference fixture, which is schemaVersion 1. A
   * consumer that finds it missing must read per-company thresholds
   * alone — that fallback is the prototype's behaviour, and it is what
   * keeps the golden master intact.
   */
  alertPolicy?: AlertPolicy | null;
  meta: Meta;
}
