/**
 * Controlled vocabularies, ported verbatim from the prototype's DATA LAYER
 * (vc-toolkit.html :203-206, :493).
 *
 * These drive the filter dropdowns and the pipeline kanban columns, and their
 * ORDER is the display order. They are not the system of record: A4 seeds
 * `ref_sector`, `ref_stage`, `ref_instrument` and `ref_funnel_stage` from
 * Affinity's own field metadata (ADR-009), at which point these move behind
 * the API. Until then the fixture is the contract and these match it.
 */

export const SECTORS = [
  'Enterprise SaaS',
  'Fintech',
  'Healthtech',
  'Climate & Energy',
  'Defense & Space',
  'AI / ML Infra',
  'Industrial Tech',
  'Consumer',
  'Logistics',
  'Cybersecurity',
] as const;

export const STAGES = ['Pre-Seed', 'Seed', 'Series A', 'Series B', 'Series C+', 'Growth'] as const;

export const INSTRUMENTS = ['SAFE', 'Convertible Note', 'Debt-to-Note', 'Preferred Equity', 'Common Equity'] as const;

/**
 * Kanban columns. Note this list does NOT include `Passed` -- the prototype
 * renders six columns and lists passed deals separately underneath, so a dead
 * deal does not take up board space. `Closed` and `Passed` are both terminal.
 */
export const FUNNEL = ['Sourced', 'Screening', 'Diligence', 'IC Review', 'Term Sheet', 'Closed'] as const;

export const GATE_STATUSES = ['pending', 'in-progress', 'passed', 'failed'] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

/**
 * Stage weights for the probability-weighted pipeline figure (:1071).
 *
 * A metric with hardcoded weights. It lives here rather than in
 * packages/metrics because it never left the view layer in the prototype
 * either; anything not listed weighs 0, which is why terminal stages
 * contribute nothing.
 */
export const FUNNEL_WEIGHTS: Record<string, number> = {
  Sourced: 0.05,
  Screening: 0.15,
  Diligence: 0.35,
  'IC Review': 0.6,
  'Term Sheet': 0.85,
};

/**
 * Filter options, taken from the DATA rather than from the constants above.
 *
 * Those constants are the prototype's vocabularies, and against a real Affinity
 * roster they match nothing: the sector dropdown would offer "Enterprise SaaS"
 * and "Fintech" to a portfolio filed under ICT, Agritech and Oceans. This
 * file's own header always said they "move behind the API at A4" -- for the
 * funnel that happened via `PortfolioExport.funnelGroups`; sector, stage and
 * instrument need no contract change, because every value in use is already
 * present on the companies themselves.
 *
 * Ordering keeps ADR-014: values known to the prototype keep the prototype's
 * order, and anything new is appended alphabetically. On the reference fixture
 * every value is a known one, so the dropdowns render exactly as before.
 *
 * Falls back to the full constant when NO company carries a value -- true of
 * stage and instrument until A6 attaches the financial spine, and an empty
 * dropdown looks broken where a stale one merely looks unused.
 */
export function optionsFrom<T extends string>(
  values: readonly (string | null | undefined)[],
  fallback: readonly T[],
): string[] {
  const present = new Set(values.filter((v): v is string => typeof v === 'string' && v.trim() !== ''));
  if (present.size === 0) return [...fallback];

  const known = fallback.filter((v) => present.has(v));
  const extra = [...present].filter((v) => !(fallback as readonly string[]).includes(v)).sort();
  return [...known, ...extra];
}
