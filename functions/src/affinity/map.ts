/**
 * Affinity v2 list entry -> platform rows. Pure: no network, no database.
 *
 * Every judgement in here is recorded in docs/affinity-v2-field-map.csv with
 * its fill rate and the reason. This module is where those decisions become
 * code, and it is deliberately separable from the I/O in sync.ts so the
 * interesting half is testable without either.
 */
import type { FieldValue, ListEntry } from './client.js';

// --- Affinity value payloads -----------------------------------------------

interface DropdownValue { dropdownOptionId: number | null; text: string; rank?: number }
interface PersonValue { id: number; firstName: string | null; lastName: string | null; primaryEmailAddress: string | null }
interface LocationValue { streetAddress: string | null; city: string | null; state: string | null; country: string | null }
interface InteractionValue { id: number; type: string; subject: string | null; sentAt: string | null }

// --- Field accessors --------------------------------------------------------

function field(entry: ListEntry, name: string): FieldValue | undefined {
  return (entry.entity.fields ?? []).find((f) => f.name === name);
}

/**
 * v2 returns `null` rather than `[]` for an empty array-valued field, so
 * absence and emptiness are the same state and must be treated as one.
 */
function value<T>(entry: ListEntry, name: string): T | null {
  const f = field(entry, name);
  if (!f || f.value === null || f.value.data === null) return null;
  return f.value.data as T;
}

function multi<T>(entry: ListEntry, name: string): T[] {
  const v = value<T | T[]>(entry, name);
  if (v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function text(entry: ListEntry, name: string): string | null {
  const v = value<string>(entry, name);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function num(entry: ListEntry, name: string): number | null {
  const v = value<number>(entry, name);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Affinity anchors date-only fields to US Pacific MIDNIGHT expressed in UTC:
 * a date of 11 August arrives as 2026-08-11T07:00:00Z. Reading the UTC date
 * is right by luck in summer and wrong by a day in winter, and reading the
 * local date is wrong for everyone east of Pacific -- which is everyone here.
 * Pin the zone (CLAUDE.md conventions, ADR-009).
 */
const PACIFIC = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function pacificDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return PACIFIC.format(d); // en-CA yields YYYY-MM-DD
}

function dateField(entry: ListEntry, name: string): string | null {
  return pacificDate(value<string>(entry, name));
}

/** Relationship-intelligence fields are interaction objects, not bare dates. */
function interactionDate(entry: ListEntry, name: string): string | null {
  const v = value<InteractionValue>(entry, name);
  return pacificDate(v?.sentAt ?? null);
}

function personName(p: PersonValue): string | null {
  const name = [p.firstName, p.lastName].filter(Boolean).join(' ').trim();
  return name === '' ? null : name;
}

// --- Sector -----------------------------------------------------------------

/**
 * Priority Sector is dropdown-MULTI against a single-FK company.sector_id.
 *
 * The primary value takes sector_id and the remainder becomes company_tag
 * rows, so nothing is dropped (decision, 12 Aug 2026). "Primary" MUST be
 * deterministic: v2 returns an unordered array, so keying on array position
 * would let a company's sector flip between nightly syncs with no data change
 * -- and move a mandate KPI when it did.
 *
 * Rule: the single non-"Other" value where there is exactly one, otherwise the
 * lowest dropdownOptionId. "Other" only wins when it is genuinely all there is.
 */
export function primarySector(values: DropdownValue[]): { primary: string | null; rest: string[] } {
  if (values.length === 0) return { primary: null, rest: [] };

  const named = values.filter((v) => v.text !== 'Other');
  const pool = named.length > 0 ? named : values;
  const primary = pool.length === 1
    ? pool[0]!
    : [...pool].sort((a, b) => (a.dropdownOptionId ?? 0) - (b.dropdownOptionId ?? 0))[0]!;

  return {
    primary: primary.text,
    rest: values.filter((v) => v.text !== primary.text).map((v) => v.text),
  };
}

// --- Mapped output ----------------------------------------------------------

export interface MappedCompany {
  affinityOrgId: string;
  affinityRowId: string;
  name: string;
  website: string | null;
  description: string | null;
  sectorLabel: string | null;
  sourceLabel: string | null;
  ceoName: string | null;
  ceoEmail: string | null;
  hqCity: string | null;
  hqRegion: string | null;
  hqCountry: string | null;
  nbRegion: string | null;
  yearFounded: number | null;
  cbTotalFundingUsd: number | null;
  affinityFmv: number | null;
  affinityTotalInvestment: number | null;
  vcLeadName: string | null;
  vcSecondaryName: string | null;
  riskGrade: string | null;
  health: string | null;
  lifecycleStatus: string | null;
  lastEmailDate: string | null;
  lastMeetingDate: string | null;
  tags: { tag: string; source: string }[];
}

export interface MappedDeal {
  affinityRowId: string;
  affinityOrgId: string;
  name: string;
  affinityStatus: string;
  sectorLabel: string | null;
  sourceLabel: string | null;
  ownerLabel: string | null;
  checkSize: number | null;
  vcLeadName: string | null;
  vcSecondaryName: string | null;
  dateAdded: string | null;
  stageChangedDate: string | null;
  followUpDate: string | null;
  lastEmailDate: string | null;
  lastMeetingDate: string | null;
  owners: { affinityPersonId: number; name: string }[];
  passReasons: { text: string; optionId: number | null }[];
  isPortfolio: boolean;
}

/**
 * Portfolio membership. ADR-009's "one list, not two": these are the Status
 * values the Portfolio saved view filters on, and the platform derives
 * membership from Status rather than from which view an entry came back in.
 *
 * There is no Affinity Status of "Closed" in the live data -- deals move from
 * Approved straight to Portfolio -- so this set is what feeds the board's
 * terminal Closed column.
 */
export const PORTFOLIO_STATUSES = new Set(['Portfolio', 'Exited', 'Closed']);

/** Affinity Risk Assessment -> the prototype's health display (ADR-009). */
const RISK_TO_HEALTH: Record<string, { grade: string; health: string | null }> = {
  'A Grade': { grade: 'A', health: 'green' },
  'B Grade': { grade: 'B', health: 'yellow' },
  'C Grade "At Risk"': { grade: 'C', health: 'red' },
  'Accelerator Investments': { grade: 'ACC', health: 'acc' },
};

export function mapEntry(entry: ListEntry): { company: MappedCompany | null; deal: MappedDeal } {
  const status = value<DropdownValue>(entry, 'Status')?.text ?? null;

  const sectors = multi<DropdownValue>(entry, 'Priority Sector');
  const { primary: sectorLabel, rest: extraSectors } = primarySector(sectors);

  // Source of Deal is dropdown-multi and carries through VERBATIM (ADR-009).
  // Where a deal has several, the first is the label and all are kept.
  const sources = multi<DropdownValue>(entry, 'Source of Deal');
  const sourceLabel = sources[0]?.text ?? null;

  /**
   * Keyed on Affinity's Person ENTITY ID, not on an email address.
   *
   * Affinity merges Person entities, so a person's primary address is not
   * reliably their @nbif.ca one -- two VC Leads carry an external domain. The
   * entity id survives both that merging and a rename, which an email or a name
   * does not (decision, 12 Aug 2026). A person with no usable name is dropped
   * rather than shown as a bare id.
   */
  const owners = multi<PersonValue>(entry, 'Owners')
    .map((p) => ({ affinityPersonId: p.id, name: personName(p) }))
    .filter((o): o is { affinityPersonId: number; name: string } => o.name !== null);

  const vcLead = value<PersonValue>(entry, 'VC Lead');
  const vcSecondary = value<PersonValue>(entry, 'VC Secondary');

  // CEO is person-multi; the first is the CEO of record. ceo_email prefers the
  // hand-typed CEO (Email) text field where present and falls back to the
  // contact record (decision, 12 Aug 2026) -- ceo_name has only one source.
  const ceo = multi<PersonValue>(entry, 'CEO')[0] ?? null;
  const ceoEmailTyped = text(entry, 'CEO (Email)');

  // Hand-maintained Company Location wins; the enriched one fills the gaps,
  // where it has better coverage (152/347 against 113/347).
  const loc = value<LocationValue>(entry, 'Company Location') ?? value<LocationValue>(entry, 'Location');

  const nbRegionRaw = value<DropdownValue>(entry, 'New Brunswick Region')?.text ?? null;
  const risk = value<DropdownValue>(entry, 'Risk Assessment')?.text ?? null;
  const mappedRisk = risk ? RISK_TO_HEALTH[risk] : undefined;

  const lastEmailDate = interactionDate(entry, 'Last Email');
  const lastMeetingDate = interactionDate(entry, 'Last Event');

  const tags: { tag: string; source: string }[] = [
    ...extraSectors.map((t) => ({ tag: t, source: 'priority-sector' })),
    ...multi<DropdownValue>(entry, 'Product/Service Industry').map((v) => ({
      tag: v.text,
      source: 'product-service-industry',
    })),
  ];

  const isPortfolio = status !== null && PORTFOLIO_STATUSES.has(status);

  const deal: MappedDeal = {
    affinityRowId: String(entry.id),
    affinityOrgId: String(entry.entity.id),
    name: entry.entity.name.trim(),
    // A Status is required: it decides membership, funnel stage and terminality.
    // Callers reject an entry without one rather than inventing a stage.
    affinityStatus: status ?? '',
    sectorLabel,
    sourceLabel,
    ownerLabel: owners.length > 0 ? owners.map((o) => o.name).join(', ') : null,
    checkSize: num(entry, 'Potential Investment Amount'),
    vcLeadName: vcLead ? personName(vcLead) : null,
    vcSecondaryName: vcSecondary ? personName(vcSecondary) : null,
    // Date Added is `created-at`, which is NOT returned by GET /lists/{id}/fields
    // -- a sync building its field list from metadata alone drops it silently.
    dateAdded: dateField(entry, 'Date Added') ?? pacificDate(entry.createdAt),
    stageChangedDate: dateField(entry, 'Deal Flow Stage Changed'),
    followUpDate: dateField(entry, 'Follow-up Date'),
    lastEmailDate,
    lastMeetingDate,
    owners,
    passReasons: multi<DropdownValue>(entry, 'Pass Reason').map((v) => ({
      text: v.text,
      optionId: v.dropdownOptionId,
    })),
    isPortfolio,
  };

  if (!isPortfolio) return { company: null, deal };

  const company: MappedCompany = {
    affinityOrgId: String(entry.entity.id),
    affinityRowId: String(entry.id),
    name: entry.entity.name.trim(),
    website: entry.entity.domain ?? entry.entity.domains?.[0] ?? null,
    description: text(entry, 'Description'),
    sectorLabel,
    sourceLabel,
    ceoName: ceo ? personName(ceo) : null,
    ceoEmail: ceoEmailTyped ?? ceo?.primaryEmailAddress?.toLowerCase() ?? null,
    hqCity: loc?.city ?? null,
    hqRegion: loc?.state ?? null,
    hqCountry: loc?.country ?? null,
    // The CHECK constraint has no N/A member; N/A means "not applicable", null.
    nbRegion: nbRegionRaw && nbRegionRaw !== 'N/A' ? nbRegionRaw : null,
    yearFounded: num(entry, 'Year Founded'),
    cbTotalFundingUsd: num(entry, 'Total Funding Amount (USD)'),
    affinityFmv: num(entry, 'FMV'),
    affinityTotalInvestment: num(entry, 'Total Investment Amount'),
    vcLeadName: deal.vcLeadName,
    vcSecondaryName: deal.vcSecondaryName,
    riskGrade: mappedRisk?.grade ?? null,
    health: mappedRisk?.health ?? null,
    lifecycleStatus: value<DropdownValue>(entry, 'Portfolio Status')?.text ?? null,
    lastEmailDate,
    lastMeetingDate,
    tags,
  };

  return { company, deal };
}
