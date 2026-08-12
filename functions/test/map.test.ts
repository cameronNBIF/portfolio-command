/**
 * Tests for the Affinity v2 -> platform mapping. Every case here corresponds
 * to a decision recorded in docs/affinity-v2-field-map.csv or to a live-data
 * shape the probe found; none is hypothetical.
 */
import { describe, expect, test } from 'vitest';

import type { FieldValue, ListEntry } from '../src/affinity/client.js';
import { mapEntry, pacificDate, primarySector, PORTFOLIO_STATUSES } from '../src/affinity/map.js';

function fv(name: string, type: string, data: unknown): FieldValue {
  return { id: `field-${name}`, name, type: 'list', enrichmentSource: null, value: data === null ? null : { type, data } };
}

function entry(fields: FieldValue[], over: Partial<ListEntry> = {}): ListEntry {
  return {
    id: 249393104,
    type: 'company',
    listId: 328745,
    createdAt: '2026-08-11T18:08:16Z',
    creatorId: 1,
    entity: { id: 313686777, name: '  EZOX  ', domain: 'ezox.com', domains: ['ezox.com'], isGlobal: true, fields },
    ...over,
  };
}

const dd = (text: string, id: number) => ({ dropdownOptionId: id, text });

describe('pacificDate', () => {
  // The live value the probe returned for Deal Flow Stage Changed.
  test('reads Pacific-midnight-anchored UTC as the intended date in summer', () => {
    expect(pacificDate('2026-08-11T07:00:00Z')).toBe('2026-08-11');
  });

  // PST is UTC-8, so the anchor moves. Reading the UTC date would give the
  // 15th here too, by luck; reading it an hour earlier would not.
  test('holds across the DST boundary', () => {
    expect(pacificDate('2026-01-15T08:00:00Z')).toBe('2026-01-15');
    expect(pacificDate('2026-01-15T07:59:00Z')).toBe('2026-01-14');
  });

  test('tolerates null and unparseable input', () => {
    expect(pacificDate(null)).toBeNull();
    expect(pacificDate('not a date')).toBeNull();
  });
});

describe('primarySector', () => {
  test('single value is the primary and leaves no remainder', () => {
    expect(primarySector([dd('ICT', 22253817)])).toEqual({ primary: 'ICT', rest: [] });
  });

  // Vetra in the live data reads "ICT; Other".
  test('prefers a named sector over Other, and keeps Other as a tag', () => {
    expect(primarySector([dd('Other', 22542066), dd('ICT', 22253817)]))
      .toEqual({ primary: 'ICT', rest: ['Other'] });
  });

  test('Other wins only when it is genuinely all there is', () => {
    expect(primarySector([dd('Other', 22542066)])).toEqual({ primary: 'Other', rest: [] });
  });

  /**
   * The property that matters: v2 returns an unordered array, so the result
   * must not depend on array position. If it did, a company's sector could
   * flip between nightly syncs and move a mandate KPI with no data change.
   */
  test('is deterministic under reordering', () => {
    const a = primarySector([dd('Agritech', 22542068), dd('Energy', 22542076)]);
    const b = primarySector([dd('Energy', 22542076), dd('Agritech', 22542068)]);
    expect(a).toEqual(b);
    expect(a.primary).toBe('Agritech'); // lowest dropdownOptionId
  });

  test('empty in, empty out', () => {
    expect(primarySector([])).toEqual({ primary: null, rest: [] });
  });
});

describe('mapEntry', () => {
  test('a pipeline entry yields a deal and no company', () => {
    const { company, deal } = mapEntry(entry([fv('Status', 'ranked-dropdown', dd('Reached Out', 22359697))]));
    expect(company).toBeNull();
    expect(deal.isPortfolio).toBe(false);
    expect(deal.affinityStatus).toBe('Reached Out');
    expect(deal.name).toBe('EZOX'); // trimmed
    expect(deal.affinityRowId).toBe('249393104');
    expect(deal.affinityOrgId).toBe('313686777');
  });

  test('a portfolio entry yields both, and Portfolio/Exited both count', () => {
    for (const status of ['Portfolio', 'Exited']) {
      const { company } = mapEntry(entry([fv('Status', 'ranked-dropdown', dd(status, 1))]));
      expect(company).not.toBeNull();
    }
    expect(PORTFOLIO_STATUSES.has('Watchlist')).toBe(false);
    expect(PORTFOLIO_STATUSES.has('Passed')).toBe(false);
  });

  /**
   * v2 returns null rather than [] for an empty array-valued field, so absence
   * and emptiness are one state. Getting this wrong throws on .length.
   */
  test('treats a null array-valued field as empty', () => {
    const { deal } = mapEntry(entry([
      fv('Status', 'ranked-dropdown', dd('New', 22359696)),
      fv('Owners', 'person-multi', null),
      fv('Pass Reason', 'dropdown-multi', null),
      fv('Priority Sector', 'dropdown-multi', null),
    ]));
    expect(deal.owners).toEqual([]);
    expect(deal.passReasons).toEqual([]);
    expect(deal.sectorLabel).toBeNull();
  });

  /**
   * Keyed on the Person ENTITY ID, never the email. Affinity merges Person
   * entities, so a primary address is not reliably the person's @nbif.ca one --
   * the entity id survives both that and a rename.
   */
  test('mirrors every owner rather than picking one, keyed on the person entity id', () => {
    const { deal } = mapEntry(entry([
      fv('Status', 'ranked-dropdown', dd('New', 22359696)),
      fv('Owners', 'person-multi', [
        { id: 253919959, firstName: 'Kyle', lastName: 'Woods', primaryEmailAddress: 'kyle.woods@creativedestructionlab.com' },
        { id: 245650078, firstName: 'Laila', lastName: 'Theriault', primaryEmailAddress: null },
      ]),
    ]));
    expect(deal.owners).toEqual([
      { affinityPersonId: 253919959, name: 'Kyle Woods' },
      { affinityPersonId: 245650078, name: 'Laila Theriault' },
    ]);
    expect(deal.ownerLabel).toBe('Kyle Woods, Laila Theriault');
  });

  // A merged entity can carry an off-domain address; the name is unaffected.
  test('VC Lead and Secondary carry names, not addresses', () => {
    const { company } = mapEntry(entry([
      fv('Status', 'ranked-dropdown', dd('Portfolio', 1)),
      fv('VC Lead', 'person', { id: 1, firstName: 'Jaime', lastName: 'Christian', primaryEmailAddress: 'jaime.a.christian@gmail.com' }),
      fv('VC Secondary', 'person', { id: 2, firstName: 'Jeff', lastName: 'White', primaryEmailAddress: 'jeff.white@nbif.ca' }),
    ]));
    expect(company!.vcLeadName).toBe('Jaime Christian');
    expect(company!.vcSecondaryName).toBe('Jeff White');
  });

  // Without a name there is nothing to display, and a bare id is not a person.
  test('drops an owner with no usable name', () => {
    const { deal } = mapEntry(entry([
      fv('Status', 'ranked-dropdown', dd('New', 22359696)),
      fv('Owners', 'person-multi', [
        { id: 7, firstName: null, lastName: null, primaryEmailAddress: 'x@y.ca' },
        { id: 8, firstName: 'Real', lastName: 'Person', primaryEmailAddress: null },
      ]),
    ]));
    expect(deal.owners).toEqual([{ affinityPersonId: 8, name: 'Real Person' }]);
  });

  // Decision, 12 Aug 2026: the hand-typed field wins where present.
  test('CEO email prefers the typed field and falls back to the contact record', () => {
    const ceo = [{ id: 9, firstName: 'Brent', lastName: 'MacDonald', primaryEmailAddress: 'bmacdonald@accesssync.com' }];
    const withTyped = mapEntry(entry([
      fv('Status', 'ranked-dropdown', dd('Portfolio', 1)),
      fv('CEO', 'person-multi', ceo),
      fv('CEO (Email)', 'text', 'brent.macdonald@elandas.com'),
    ]));
    expect(withTyped.company!.ceoEmail).toBe('brent.macdonald@elandas.com');
    expect(withTyped.company!.ceoName).toBe('Brent MacDonald');

    const withoutTyped = mapEntry(entry([
      fv('Status', 'ranked-dropdown', dd('Portfolio', 1)),
      fv('CEO', 'person-multi', ceo),
    ]));
    expect(withoutTyped.company!.ceoEmail).toBe('bmacdonald@accesssync.com');
  });

  test('extra sectors and industries become tags, not sectors', () => {
    const { company } = mapEntry(entry([
      fv('Status', 'ranked-dropdown', dd('Portfolio', 1)),
      fv('Priority Sector', 'dropdown-multi', [dd('ICT', 22253817), dd('Other', 22542066)]),
      fv('Product/Service Industry', 'dropdown-multi', [dd('Crm', 22369025), dd('Saas', 22369013)]),
    ]));
    expect(company!.sectorLabel).toBe('ICT');
    expect(company!.tags).toEqual([
      { tag: 'Other', source: 'priority-sector' },
      { tag: 'Crm', source: 'product-service-industry' },
      { tag: 'Saas', source: 'product-service-industry' },
    ]);
  });

  test('risk assessment drives grade and health, with ACC carrying no colour grade', () => {
    const grade = (t: string) => mapEntry(entry([
      fv('Status', 'ranked-dropdown', dd('Portfolio', 1)),
      fv('Risk Assessment', 'ranked-dropdown', dd(t, 1)),
    ])).company!;
    expect(grade('A Grade')).toMatchObject({ riskGrade: 'A', health: 'green' });
    expect(grade('C Grade "At Risk"')).toMatchObject({ riskGrade: 'C', health: 'red' });
    expect(grade('Accelerator Investments')).toMatchObject({ riskGrade: 'ACC', health: 'acc' });
  });

  // The CHECK constraint on company.nb_region has no N/A member.
  test('New Brunswick Region N/A becomes null, not the string', () => {
    const region = (t: string) => mapEntry(entry([
      fv('Status', 'ranked-dropdown', dd('Portfolio', 1)),
      fv('New Brunswick Region', 'dropdown', dd(t, 1)),
    ])).company!.nbRegion;
    expect(region('N/A')).toBeNull();
    expect(region('SW')).toBe('SW');
  });

  test('relationship-intelligence fields are interaction objects, not dates', () => {
    const { deal } = mapEntry(entry([
      fv('Status', 'ranked-dropdown', dd('New', 22359696)),
      fv('Last Email', 'interaction', { id: 1, type: 'email', subject: 'NBIF // EZOX', sentAt: '2026-08-07T15:48:27Z' }),
      fv('Last Event', 'interaction', { id: 2, type: 'meeting', subject: null, sentAt: '2026-07-21T16:00:00Z' }),
    ]));
    expect(deal.lastEmailDate).toBe('2026-08-07');
    expect(deal.lastMeetingDate).toBe('2026-07-21');
  });

  /**
   * Date Added comes from `created-at`, which GET /lists/{id}/fields does not
   * enumerate. If it is missing the entry's own createdAt stands in, so a sync
   * that builds its field list from metadata alone still dates its deals.
   */
  test('falls back to listEntry.createdAt when Date Added is absent', () => {
    const { deal } = mapEntry(entry([fv('Status', 'ranked-dropdown', dd('New', 22359696))]));
    expect(deal.dateAdded).toBe('2026-08-11');

    const withField = mapEntry(entry([
      fv('Status', 'ranked-dropdown', dd('New', 22359696)),
      fv('Date Added', 'datetime', '2025-12-02T08:00:00Z'),
    ]));
    expect(withField.deal.dateAdded).toBe('2025-12-02');
  });

  test('hand-maintained location wins, enriched fills the gap', () => {
    const hand = { streetAddress: null, city: 'Fredericton', state: 'New Brunswick', country: 'Canada' };
    const enriched = { streetAddress: null, city: 'Saint John', state: 'New Brunswick', country: 'Canada' };
    const both = mapEntry(entry([
      fv('Status', 'ranked-dropdown', dd('Portfolio', 1)),
      fv('Company Location', 'location', hand),
      fv('Location', 'location', enriched),
    ]));
    expect(both.company!.hqCity).toBe('Fredericton');

    const only = mapEntry(entry([
      fv('Status', 'ranked-dropdown', dd('Portfolio', 1)),
      fv('Location', 'location', enriched),
    ]));
    expect(only.company!.hqCity).toBe('Saint John');
  });

  test('pass reasons keep their option id so a rename stays traceable', () => {
    const { deal } = mapEntry(entry([
      fv('Status', 'ranked-dropdown', dd('Passed', 22359708)),
      fv('Pass Reason', 'dropdown-multi', [dd('Too early', 22875405), dd('Team', 22359714)]),
    ]));
    expect(deal.passReasons).toEqual([
      { text: 'Too early', optionId: 22875405 },
      { text: 'Team', optionId: 22359714 },
    ]);
  });

  test('an entry with no domain maps to a null website rather than throwing', () => {
    const { company } = mapEntry(entry(
      [fv('Status', 'ranked-dropdown', dd('Portfolio', 1))],
      { entity: { id: 1, name: 'No Domain Co', domain: null, domains: [], isGlobal: true, fields: [fv('Status', 'ranked-dropdown', dd('Portfolio', 1))] } },
    ));
    expect(company!.website).toBeNull();
  });
});
