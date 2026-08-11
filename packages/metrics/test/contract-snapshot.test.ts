/**
 * The ADR-001 export contract does not drift.
 *
 * `GET /api/v1/export` emits the prototype's Data-tab schema field for field,
 * and Daniel's export -> edit -> re-import loop depends on it not moving. This
 * test snapshots the STRUCTURE -- every field path, its type, its nesting and
 * its optionality -- rather than the values, because values are the golden
 * master's job and a structural fingerprint is what catches a rename, a
 * retype, a moved field or a silent unit change.
 *
 * A failure here means the contract changed. That is either a mistake, or a
 * deliberate decision that also bumps `meta.schemaVersion` and updates
 * docs/architecture-decisions.md. It is never something to re-baseline
 * casually.
 *
 * `meta.savedAt` is normalised out (ADR-022): it is a wall-clock stamp written
 * by the prototype's saveDB(), and a timestamp drifting is not contract drift.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PortfolioExport } from '@portfolio-command/contract';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const demo = JSON.parse(
  readFileSync(path.resolve(here, '../../../docs/reference/demo.json'), 'utf8'),
) as PortfolioExport;

/** Sentinel replacing any value that legitimately varies between exports. */
const NORMALISED = '<normalised>';

function normalise(doc: PortfolioExport): PortfolioExport {
  return { ...doc, meta: { ...doc.meta, savedAt: NORMALISED as unknown as null } };
}

/**
 * A structural fingerprint: every field path mapped to the set of types seen
 * there, unioned across array elements so one company with a null `govFunding`
 * and another with an object both register.
 *
 * Arrays collapse to `[]` in the path, so `companies[].rounds[].roundTotal` is
 * one entry however many rounds exist. That keeps the snapshot a description
 * of the CONTRACT rather than of the dataset -- adding a company must not
 * change it, but adding a field to a company must.
 */
function fingerprint(value: unknown, prefix = '', out = new Map<string, Set<string>>()): Map<string, Set<string>> {
  const record = (type: string) => {
    if (!out.has(prefix)) out.set(prefix, new Set());
    out.get(prefix)!.add(type);
  };

  if (value === null) {
    record('null');
  } else if (Array.isArray(value)) {
    record('array');
    for (const item of value) fingerprint(item, `${prefix}[]`, out);
  } else if (typeof value === 'object') {
    record('object');
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      fingerprint(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else {
    record(typeof value);
  }
  return out;
}

function fingerprintLines(doc: PortfolioExport): string[] {
  const map = fingerprint(normalise(doc));
  return [...map.entries()]
    .map(([p, types]) => `${p || '<root>'}: ${[...types].sort().join('|')}`)
    .sort();
}

describe('ADR-001 export contract', () => {
  it('emits schemaVersion 1', () => {
    // Bumps only when the CONTRACT changes. Storage changes underneath do not.
    expect(demo.meta.schemaVersion).toBe(1);
  });

  it('has the six top-level keys, and only those', () => {
    expect(Object.keys(demo).sort()).toEqual([
      'companies',
      'fund',
      'fundInvestments',
      'memos',
      'meta',
      'pipeline',
    ]);
  });

  it('normalises savedAt so a re-export does not fail the build', () => {
    // The committed export happens to carry null because it came from an
    // unsaved session; one taken after a Save would carry an ISO timestamp.
    // Neither is contract drift.
    expect(normalise(demo).meta.savedAt).toBe(NORMALISED);
    expect(normalise({ ...demo, meta: { ...demo.meta, savedAt: '2026-08-11T10:00:00.000Z' } }).meta.savedAt).toBe(
      NORMALISED,
    );
  });

  it('keeps money in $M, not dollars', () => {
    // The single sharpest way this contract could break silently: the database
    // stores dollars (ADR-008) and the API converts in exactly one place
    // (ADR-001, ADR-021). If that conversion were dropped, every figure here
    // would be ~1e6 too large while every field name stayed identical -- and a
    // name-and-type snapshot alone would not notice.
    const totalInvested = demo.companies.reduce((s, c) => s + c.invested, 0);
    expect(totalInvested).toBeGreaterThan(1);
    expect(totalInvested).toBeLessThan(100_000);
    expect(demo.fund.capitalBase).toBeLessThan(100_000);
    for (const c of demo.companies) {
      expect(c.invested, `${c.id} invested looks like dollars, not $M`).toBeLessThan(100_000);
    }
  });

  it('keeps percentages as plain numbers, not fractions', () => {
    // 11.2 means 11.2%, never 0.112.
    const owned = demo.companies.filter((c) => c.ownershipPct > 0);
    expect(owned.length).toBeGreaterThan(0);
    expect(Math.max(...owned.map((c) => c.ownershipPct))).toBeGreaterThan(1);
    for (const c of owned) expect(c.ownershipPct).toBeLessThanOrEqual(100);
  });

  it('keeps dates as YYYY-MM-DD strings', () => {
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    for (const c of demo.companies) {
      for (const r of c.rounds) expect(r.date, `${c.id} round date`).toMatch(iso);
      for (const m of c.marks) expect(m.date, `${c.id} mark date`).toMatch(iso);
    }
    for (const d of demo.fund.distributions) expect(d.date).toMatch(iso);
    for (const f of demo.fundInvestments) {
      for (const cf of f.cashflows) expect(cf.date, `${f.id} cashflow date`).toMatch(iso);
    }
  });

  it('matches the frozen structural fingerprint', () => {
    // Every field path and type in the contract. A rename, a retype, a moved
    // field or a new required field all land here.
    expect(fingerprintLines(demo)).toMatchSnapshot();
  });
});
