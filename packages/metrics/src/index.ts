/**
 * Portfolio Command -- metric definitions.
 *
 * Pure functions over the ADR-001 contract shape (ADR-021). No React, no
 * database, no I/O, no clock. Every function takes what it needs as an
 * argument and returns a value.
 *
 * DEFINITIONS ARE FROZEN at the v1 prototype's implementations (ADR-013) and
 * guarded by golden-master fixtures captured from `docs/reference/demo.json`
 * (ADR-022). **A failing golden-master test means the code is wrong, never the
 * fixture.** Behaviour that looks accidental was ported anyway and is
 * inventoried in INHERITED-COERCIONS.md; that file, not this one, is where a
 * correctness review starts.
 *
 * Metrics are never computed in a React component and never in SQL (ADR-003,
 * ADR-023). Import from here.
 */

export { fmt, count, ratio, signedPct, DISPLAY_LOCALE } from './format.js';
export { xirr, type Cashflow } from './xirr.js';

export { moic, activeCompanies, suggestedReserve, totalGainLoss, unrealizedGain } from './company.js';

export { fundMetrics, isEvergreen, type FundMetrics, type MetricOptions } from './fund.js';

export { fiTvpi, fiDpi, fiIrr, lpMetrics, fiMetrics, type LpMetrics } from './lp.js';

export { healthAlerts, type HealthAlert, type Severity } from './alerts.js';

export {
  scenarioDefaults,
  runScenario,
  type ScenarioInputs,
  type ScenarioCase,
  type ScenarioResult,
} from './scenario.js';

export {
  leverage,
  nbCoInvestment,
  fmvGrowth,
  multiples,
  irr,
  jobs,
  revenue,
  diversityWithCoverage,
  hasCapitalBasis,
  type DiversityCoverage,
} from './selectors.js';
