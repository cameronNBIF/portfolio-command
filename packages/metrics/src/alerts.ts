/**
 * Health alerts, ported verbatim from vc-toolkit.html :653-664 (ADR-013).
 */
import type { Company, PortfolioExport } from '@portfolio-command/contract';

import { activeCompanies } from './company.js';

export type Severity = 'red' | 'yellow';

export interface HealthAlert {
  company: Company;
  sev: Severity;
  text: string;
}

/**
 * Open alerts across the active portfolio, red first.
 *
 * Four sources: runway below threshold, risk flags, covenants in breach or on
 * watch, and government funding with conditions pending.
 *
 * INHERITED, three things.
 *
 * 1. The runway alert is gated on `c.thresholds.minRunwayMo` being TRUTHY, so a
 *    threshold of 0 disables it rather than firing on everything. Two companies
 *    in the reference dataset carry an empty `thresholds` object.
 * 2. Risk flags are de-duplicated against the runway alert by REGEX ON DISPLAY
 *    TEXT (`!/Runway/i.test(f)`). Renaming a flag silently duplicates or
 *    silently suppresses an alert. Covenant and government-funding status are
 *    matched the same way, against free text.
 * 3. The final sort comparator is TWO-VALUED -- red against everything else --
 *    and relies on `Array.prototype.sort` stability for the rest of the
 *    ordering. Stability is guaranteed by the language spec since ES2019, so
 *    this is deterministic; but the sort must not be replaced with one that
 *    orders ties differently. The fixture freezes the full sequence.
 *
 * See INHERITED-COERCIONS.md §7 and §12.
 */
export function healthAlerts(db: PortfolioExport): HealthAlert[] {
  const out: HealthAlert[] = [];

  activeCompanies(db.companies).forEach((c) => {
    const k = c.kpis && c.kpis[0];

    if (k && c.thresholds && c.thresholds.minRunwayMo && k.runwayMo < c.thresholds.minRunwayMo) {
      out.push({
        company: c,
        sev: k.runwayMo < 6 ? 'red' : 'yellow',
        text: `Runway ${k.runwayMo} mo (threshold ${c.thresholds.minRunwayMo})`,
      });
    }

    (c.riskFlags || []).forEach((f) => {
      if (!/Runway/i.test(f)) {
        out.push({ company: c, sev: c.health === 'red' ? 'red' : 'yellow', text: f });
      }
    });

    (c.covenants || []).forEach((cv) => {
      if (/breach|watch/i.test(cv.status)) {
        out.push({
          company: c,
          sev: /breach/i.test(cv.status) ? 'red' : 'yellow',
          text: `Covenant: ${cv.text} (${cv.status})`,
        });
      }
    });

    if (c.govFunding && /pending|risk/i.test(c.govFunding.status)) {
      out.push({
        company: c,
        sev: 'yellow',
        text: `Gov funding: ${c.govFunding.program} - ${c.govFunding.status}`,
      });
    }
  });

  return out.sort((a, b) => (a.sev === 'red' ? 0 : 1) - (b.sev === 'red' ? 0 : 1));
}
