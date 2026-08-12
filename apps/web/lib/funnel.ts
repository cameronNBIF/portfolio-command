/**
 * The pipeline board's view model, derived from the contract rather than
 * hardcoded.
 *
 * The prototype had one funnel vocabulary of seven values and could hardcode
 * the board (`FUNNEL`, `vc-toolkit.html:206`), the "active" test
 * (`!["Closed","Passed"].includes(...)`, :1068) and the stage weights (:1071).
 * Affinity has SIXTEEN statuses and they are what a deal now carries, because
 * they are the terms the investment team speaks and flattening them would lose
 * a company's position between the two systems (ADR-009).
 *
 * So the columns, their order, which groups render on the board at all, and
 * which are terminal all come from `PortfolioExport.funnelGroups` — which is
 * `ref_funnel_group` — and a re-binning is a row edit rather than a deploy.
 *
 * The WEIGHTS stay in the view layer keyed on the GROUP name. They were never
 * in `packages/metrics` and they are not moving there; keying them on the group
 * means the prototype's five numbers apply unchanged, so no board figure moves
 * (ADR-013).
 */
import type { FunnelGroup, PortfolioExport } from '@portfolio-command/contract';

import { FUNNEL, FUNNEL_WEIGHTS } from './constants';

export interface FunnelView {
  /** Groups that get a kanban column, in display order. */
  columns: FunnelGroup[];
  /** Terminal groups with no column — Passed and Watchlist — in display order. */
  offBoard: FunnelGroup[];
  /** The group a stage renders in, or the stage itself if it maps to none. */
  groupOf: (stage: string) => string;
  /** True when the deal has come to rest: excluded from "active". */
  isTerminal: (stage: string) => boolean;
  /** Probability weight for the weighted-pipeline figure. 0 for terminal groups. */
  weightOf: (stage: string) => number;
  /** Every stage rendering in a named group. */
  stagesIn: (groupName: string) => string[];
}

/**
 * The schemaVersion 1 shape, for a document with no `funnelGroups` — which is
 * `docs/reference/demo.json`, frozen at the prototype's seven values (ADR-022).
 * Each stage is its own group, which reproduces the prototype exactly.
 */
function fallbackGroups(): FunnelGroup[] {
  return [
    ...FUNNEL.map((name) => ({
      name,
      isTerminal: name === 'Closed',
      showOnBoard: true,
      stages: [name],
    })),
    { name: 'Passed', isTerminal: true, showOnBoard: false, stages: ['Passed'] },
  ];
}

export function funnelView(db: PortfolioExport): FunnelView {
  const groups = db.funnelGroups?.length ? db.funnelGroups : fallbackGroups();

  const byStage = new Map<string, FunnelGroup>();
  for (const g of groups) for (const stage of g.stages) byStage.set(stage, g);

  return {
    columns: groups.filter((g) => g.showOnBoard),
    offBoard: groups.filter((g) => !g.showOnBoard),
    // An unmapped stage is its own group rather than a silent disappearance: a
    // deal must never vanish from the board because Affinity gained a status
    // nobody has binned yet.
    groupOf: (stage) => byStage.get(stage)?.name ?? stage,
    isTerminal: (stage) => byStage.get(stage)?.isTerminal ?? false,
    weightOf: (stage) => {
      const group = byStage.get(stage);
      if (group?.isTerminal) return 0;
      return FUNNEL_WEIGHTS[group?.name ?? stage] ?? 0;
    },
    stagesIn: (groupName) => groups.find((g) => g.name === groupName)?.stages ?? [],
  };
}
