/**
 * The fund row's identity and configuration, in one place because two commands
 * now depend on it agreeing with itself.
 *
 * `db:seed` creates the row on a fresh database. `fixture:purge` puts it back
 * after the reference fixture has overwritten it with the prototype's fictional
 * vehicle -- the import REPLACES the fund row, so a database that has held
 * `demo.json` is reporting as "Ridgeline Direct Investments", in USD, on a $400M
 * capital base, until something restores it. If the purge restored a different
 * identity than the seed creates, a rebuilt database and a purged one would
 * disagree on the name at the top of every board-facing screen, and neither
 * would be obviously wrong.
 *
 * The rationale is the seed's, unchanged: `fund` is CONFIGURATION, not financial
 * history. Two values are CONFIRMED and hardcoded -- the vehicle is evergreen
 * (`docs/field-inventory.csv`) and the fiscal year starts in April (ADR-006).
 * Name and inception year are marked "Platform (user entry)" in that same
 * inventory, so they come from the environment and are NOT invented here. The
 * defaults are deliberately conspicuous: a provisional fund name renders on
 * screen, which is the point.
 *
 * FINANCIAL FIELDS ARE NOT HERE, and their absence is the specification. A
 * capital base nobody supplied would be a fabricated board number, which is
 * exactly what ADR-020 exists to prevent -- so the seed leaves them NULL and the
 * purge sets them back to NULL rather than carrying the fixture's figures
 * forward under NBIF's name.
 */
import { loadEnv } from './env.js';

export interface FundIdentity {
  name: string;
  style: string;
  currency: string;
  inceptionYear: number | null;
  fiscalYearStartMonth: number;
  annualPlatformTarget: number | null;
}

/**
 * The fixture's own figures, which the seed never writes and the purge always
 * clears. Named here so the two commands cannot drift on what "not supplied"
 * means for the fund row.
 */
export const FUND_FINANCIAL_COLUMNS = [
  'capital_base',
  'committed',
  'called',
  'fee_drag_pct',
  'distribution_policy',
  'reserves_policy',
  'annual_followon_budget',
] as const;

/** Reads `.env` first, so a module-level caller cannot see an empty environment. */
export function fundIdentity(): FundIdentity {
  loadEnv();
  return {
    name: process.env.FUND_NAME ?? 'NBIF — fund name not yet configured',
    style: 'evergreen',
    currency: 'CAD',
    inceptionYear: Number(process.env.FUND_INCEPTION_YEAR) || null,
    fiscalYearStartMonth: 4,
    annualPlatformTarget: Number(process.env.FUND_ANNUAL_PLATFORM_TARGET) || null,
  };
}
