/**
 * IC memo sections and auto-prefill, ported from `MEMO_SECTIONS`,
 * `memoEntities` and `prefillMemo` (vc-toolkit.html :1131-1165).
 *
 * This is content generation, not metric definition -- it assembles sentences
 * from figures the metrics package has already computed. It stays in the app
 * for that reason.
 */
import type { Company, PipelineDeal, PortfolioExport } from '@portfolio-command/contract';
import { fmt, moic } from '@portfolio-command/metrics';

/** Section key and heading, in order. */
export const MEMO_SECTIONS: [string, string][] = [
  ['exec', 'Executive Summary'],
  ['thesis', 'Investment Thesis'],
  ['market', 'Market & Competition'],
  ['team', 'Team Assessment'],
  ['topgrading', 'Topgrading Appendix'],
  ['product', 'Product & Technology'],
  ['traction', 'Traction & KPIs'],
  ['terms', 'Deal Terms'],
  ['captable', 'Cap Table & Ownership'],
  ['risks', 'Risk Register'],
  ['returns', 'Returns Model'],
  ['reco', 'Recommendation'],
];

/** Which sections are auto-populated, and say so on screen. */
export const AUTO_POPULATED = new Set(['terms', 'captable', 'traction', 'risks']);

export type Memo = Record<string, string>;

export interface MemoEntity {
  id: string;
  label: string;
}

/** Pipeline deals that are still live, then active portfolio companies (:1138-1141). */
export function memoEntities(db: PortfolioExport): MemoEntity[] {
  return [
    ...db.pipeline.filter((d) => d.funnel !== 'Passed').map((d) => ({ id: d.id, label: `${d.name} (pipeline - ${d.funnel})` })),
    ...db.companies.filter((c) => !c.exited).map((c) => ({ id: c.id, label: `${c.name} (portfolio)` })),
  ];
}

function prefillFromCompany(c: Company): Memo {
  const mo = moic(c);
  const k = c.kpis && c.kpis[0];
  const m: Memo = {};

  m.exec =
    `${c.name} (${c.sector}, ${c.stage}) - follow-on / update memo. Current position: ${fmt.m(c.invested)} invested at ` +
    `${fmt.pct(c.ownershipPct)} ownership via ${c.instrument}; marked at ${fmt.m(c.fmv)} (${fmt.x(mo)} MOIC). ` +
    `Health: ${c.health.toUpperCase()}${c.riskFlags.length ? ` - flags: ${c.riskFlags.join('; ')}` : ''}.`;

  // D-2: the prototype wrote "run-rate" here. Visible supplies the period
  // actual, so the wording changes and the figure does not (ADR-013).
  m.traction = k
    ? `Latest (${k.period}): revenue ${fmt.m(k.revenue)} for the quarter as reported, monthly burn ` +
      `${k.burn < 0 ? 'cash-flow positive' : fmt.m(k.burn)}, cash ${fmt.m(k.cash)}, runway ` +
      `${k.runwayMo >= 99 ? '99+' : k.runwayMo} months.`
    : '';

  m.terms = c.rounds
    .map(
      (r) =>
        `${r.date} ${r.label}: ${fmt.m(r.invested)} via ${r.instrument}` +
        `${r.postMoney ? ` at ${fmt.m(r.postMoney)} post` : ''} (lead: ${r.lead})${r.note ? ` - ${r.note}` : ''}`,
    )
    .join('\n');

  m.captable =
    `Current ownership ${fmt.pct(c.ownershipPct)} (${c.instrument}). Pro-rata rights: ${c.proRata ? 'yes' : 'no'}. ` +
    `Reserves: ${fmt.m(c.reservesAllocated)} allocated, ${fmt.m((c.reservesAllocated || 0) - (c.reservesDeployed || 0))} remaining. ` +
    `Board: ${c.board.seat}${c.board.seat !== 'None' ? ` (${c.board.holder})` : ''}.`;

  m.risks =
    (c.riskFlags || []).map((f) => `- ${f}`).join('\n') +
    (c.covenants || []).map((cv) => `\n- Covenant: ${cv.text} [${cv.status}]`).join('') +
    (c.govFunding ? `\n- Gov funding condition: ${c.govFunding.program} - ${c.govFunding.conditions}` : '');

  m.returns =
    `Entry basis ${fmt.m(c.invested)}; current mark ${fmt.m(c.fmv)} (${fmt.x(mo)}). Scenario grid to complete: ` +
    `bear / base / bull exit values, expected proceeds at current ownership ${fmt.pct(c.ownershipPct)} ` +
    `(before future dilution).`;

  m.thesis = c.desc || '';
  return m;
}

function prefillFromDeal(d: PipelineDeal): Memo {
  const m: Memo = {};
  const ownership = d.valuation && d.checkSize ? fmt.pct((d.checkSize / d.valuation) * 100) : null;

  m.exec =
    `${d.name} (${d.sector}) - new platform investment. Proposed ${fmt.m(d.checkSize)}` +
    `${d.valuation ? ` at ${fmt.m(d.valuation)} post (${ownership} ownership)` : ''}. Stage: ${d.funnel}. ` +
    `Source: ${d.source}. Diligence gates: ${d.gates.filter((g) => g.status === 'passed').length}/${d.gates.length} passed.`;

  m.terms = d.termSheet
    ? Object.entries({
        Security: d.termSheet.security,
        'Pre-money': fmt.m(d.termSheet.preMoney),
        'Post-money': fmt.m(d.termSheet.postMoney),
        Investment: fmt.m(d.termSheet.investment),
        Ownership: fmt.pct(d.termSheet.ownership),
        'Liq. pref': d.termSheet.liquidation,
        'Anti-dilution': d.termSheet.antiDilution,
        Board: d.termSheet.board,
        'Pro-rata': d.termSheet.proRata,
        Dividends: d.termSheet.dividends,
        'Option pool': d.termSheet.optionPool,
        'Founder vesting': d.termSheet.founderVesting,
      })
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
    : `Term sheet not yet issued. Proposed: ${fmt.m(d.checkSize)}${d.valuation ? ` at ${fmt.m(d.valuation)} post.` : ''}`;

  m.risks =
    '- [Complete] Key diligence risks from open gates:\n' +
    d.gates
      .filter((g) => g.status !== 'passed')
      .map((g) => `  - ${g.name} (${g.status})`)
      .join('\n');

  // INHERITED: `checkSize/valuation * valuation*3 * 0.75` reduces to
  // checkSize * 2.25 -- ownership times a 3x exit, less 25% dilution. Verbose
  // but correct, and reproduced as written (INHERITED-COERCIONS.md).
  m.returns =
    d.valuation && d.checkSize
      ? `Entry: ${fmt.m(d.checkSize)} for ${ownership}. Sketch: 3x exit (${fmt.m(d.valuation * 3)}) returns ` +
        `~${fmt.m((d.checkSize / d.valuation) * d.valuation * 3 * 0.75)} assuming 25% future dilution; 5x and 10x cases ` +
        `to model with full waterfall.`
      : '';

  return m;
}

/** Auto-populate a memo from portfolio or pipeline data (:1142-1165). */
export function prefillMemo(db: PortfolioExport, id: string, pipeline: PipelineDeal[]): Memo {
  const c = db.companies.find((x) => x.id === id);
  const d = pipeline.find((x) => x.id === id);

  const m: Memo = c ? prefillFromCompany(c) : d ? prefillFromDeal(d) : {};

  for (const [key] of MEMO_SECTIONS) if (!(key in m)) m[key] = '';

  m.topgrading =
    m.topgrading ||
    'Scorecard per key executive: mission, outcomes, competencies, reference summary (threshold: A-player bar).\n\nCEO -\nCTO -\nVP Sales -';
  m.reco = m.reco || '[Invest / Pass / Hold-follow-on] - recommended check, conditions precedent, proposed board role.';
  return m;
}

/** Markdown export, matching `exportMemoMd` (:1199-1204). */
export function memoToMarkdown(fundName: string, label: string, memo: Memo, dateStamp: string): string {
  const name = label.replace(/\s*\(.*/, '');
  let md = `# Investment Memorandum - ${name}\n\n*${fundName} - ${dateStamp} - Confidential*\n\n`;
  MEMO_SECTIONS.forEach(([k, heading], i) => {
    md += `## ${i + 1}. ${heading}\n\n${memo[k] || '_TBD_'}\n\n`;
  });
  return md;
}
