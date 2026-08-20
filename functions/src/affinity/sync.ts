/**
 * The Affinity -> Portfolio Command write path (A4).
 *
 * Reads the whole NBIF Master list and upserts it into `company`,
 * `company_state`, `company_tag`, `pipeline_deal`, `pipeline_deal_owner` and
 * `pipeline_deal_pass_reason`.
 *
 * FIVE RULES GOVERN IT:
 *
 * 1. **One way, inbound (ADR-009).** Nothing is written back. The client
 *    exposes only GET, so this is a property of the code.
 *
 * 2. **Upsert, never truncate.** The ADR-001 importer replaces the document
 *    wholesale because that is the semantic of an export/edit/re-import loop.
 *    This is a nightly incremental against a live CRM, so it converges instead:
 *    running it twice must change nothing the second time.
 *
 * 3. **It never deletes.** A row that stops appearing in Affinity keeps its
 *    platform-owned children -- gates, term sheets, memos, financial history --
 *    and is reported as unseen rather than removed. `synced_at` is what makes
 *    staleness visible, and deleting a company would cascade through the
 *    transaction registry.
 *
 * 4. **Reference keys resolve on exact match only (ADR-026).** The verbatim
 *    string is always stored. Nothing is coerced to a nearest neighbour and no
 *    reference row is invented.
 *
 * 5. **Membership comes from Status, not from which view a row came back in
 *    (ADR-009).** Pipeline and Portfolio are saved views of one list, and a
 *    company graduating between two nightly runs is a status change rather
 *    than a disappearance and an arrival.
 *
 * Money: Affinity's FMV and Total Investment Amount are stored as REFERENCE
 * ONLY and never enter a calculation (ADR-020). They arrive as dollars and are
 * stored as dollars, so nothing here crosses the $M boundary.
 */
import type pg from 'pg';

import type { AffinityClient, ListEntry } from './client.js';
import { NBIF_MASTER_LIST_ID } from './client.js';
import { mapEntry, type MappedCompany, type MappedDeal } from './map.js';


/** The system principal seeded by `packages/db/src/seed.ts`. */
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Requesting every field type is what makes this one paginated call rather
 * than a per-entry fan-out. Omitting them returns entities with NO field data.
 */
const FIELD_TYPES = ['enriched', 'global', 'list', 'relationship-intelligence'] as const;

export interface SyncWarning {
  kind: 'unresolved-reference' | 'data-quality' | 'unseen';
  subject: string;
  field: string;
  detail: string;
}

export interface SyncResult {
  startedAt: string;
  entriesRead: number;
  apiCalls: number;
  counts: Record<string, number>;
  warnings: SyncWarning[];
}

export interface SyncOptions {
  listId?: number;
  /** Read and map, then roll back. Used to rehearse against production data. */
  dryRun?: boolean;
}

/** `Cnnn` / `Pnnn` display ids, preserved for export readability. */
function formatId(prefix: 'C' | 'P', n: number): string {
  return `${prefix}${String(n).padStart(3, '0')}`;
}

/**
 * Allocates the next unused number for a prefix.
 *
 * Ids must be STABLE across a database rebuild or every exported id shifts, so
 * callers allocate in a deterministic order (entries sorted by Affinity entity
 * id) and existing rows keep whatever they already have. Taken numbers are
 * skipped rather than overwritten, so a roster loaded beside the reference
 * fixture cannot collide with C001-C070.
 */
function makeAllocator(prefix: 'C' | 'P', taken: Set<string>) {
  let next = 1;
  return (): string => {
    let id = formatId(prefix, next);
    while (taken.has(id)) id = formatId(prefix, ++next);
    taken.add(id);
    return id;
  };
}

export async function syncAffinity(
  client: pg.Client,
  af: AffinityClient,
  { listId = NBIF_MASTER_LIST_ID, dryRun = false }: SyncOptions = {},
): Promise<SyncResult> {
  const startedAt = new Date().toISOString();
  const warnings: SyncWarning[] = [];
  const counts: Record<string, number> = {};
  const bump = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);

  // Session-level, not `set local`: the reference and identity reads below
  // happen BEFORE the write transaction opens, and they need the schema too.
  await client.query('set search_path = pc, public');

  const callsBefore = af.calls;
  const entries = await af.collect<ListEntry>(`/lists/${listId}/list-entries`, {
    fieldTypes: FIELD_TYPES,
    limit: 100,
  });

  // --- reference vocabularies, for exact-match resolution only (ADR-026) ---
  const lookup = async (sqlText: string) => {
    const { rows } = await client.query<{ id: number | string; name: string }>(sqlText);
    return new Map(rows.map((r) => [r.name, r.id]));
  };
  const sectors = (await lookup('select sector_id as id, name from ref_sector')) as Map<string, number>;
  const channels = (await lookup(
    'select source_channel_id as id, name from ref_source_channel',
  )) as Map<string, number>;
  // Resolved through affinity_status_map, never by matching text against
  // ref_funnel_stage directly -- the table is the seam ADR-009 requires for
  // routing a renamed or newly-added status without a deploy.
  const funnelStages = (await lookup(
    'select funnel_stage_id as id, affinity_status as name from affinity_status_map',
  )) as Map<string, number>;
  /**
   * ADR-036. Membership from the SAME table, for the reason the comment above
   * gives about the funnel stage. It was a hardcoded Set in `map.ts` until F4,
   * which needed a second question of the same kind -- which status means
   * EXITED -- and two rules a file apart is how a company ends up on the roster
   * and in neither view.
   *
   * A status with no row, or a row saying false, is not a member. That is the
   * safe default for an option added in Affinity without a deploy: it changes
   * no view until somebody says what it means.
   */
  const { rows: statusRules } = await client.query<{
    affinity_status: string; is_portfolio_member: boolean; is_exited: boolean;
  }>('select affinity_status, is_portfolio_member, is_exited from affinity_status_map');
  const membership = new Map(statusRules.map((r) => [r.affinity_status, r]));
  /**
   * Matched on DISPLAY NAME, not email (decision, 12 Aug 2026). Affinity merges
   * Person entities, so a person's primary address is not reliably their
   * @nbif.ca one and joining on it silently failed. For an eight-person team
   * whose names are unique this is the more reliable key, and the label stands
   * alone where nobody has an account yet.
   */
  const users = (await lookup('select user_id as id, display_name as name from app_user')) as Map<
    string,
    string
  >;

  const unresolved = new Map<string, Set<string>>();
  function resolve<T>(map: Map<string, T>, label: string | null, what: string): T | null {
    if (label === null || label === '') return null;
    const id = map.get(label);
    if (id === undefined) {
      if (!unresolved.has(what)) unresolved.set(what, new Set());
      unresolved.get(what)!.add(label);
      return null;
    }
    return id;
  }

  // --- existing identity, so a re-run keeps every id it already issued ------
  const { rows: existingCompanies } = await client.query<{ company_id: string; affinity_org_id: string | null }>(
    'select company_id, affinity_org_id from company',
  );
  const { rows: existingDeals } = await client.query<{ deal_id: string; affinity_row_id: string | null }>(
    'select deal_id, affinity_row_id from pipeline_deal',
  );

  const companyIdByOrg = new Map(
    existingCompanies.filter((r) => r.affinity_org_id).map((r) => [r.affinity_org_id!, r.company_id]),
  );
  const dealIdByRow = new Map(
    existingDeals.filter((r) => r.affinity_row_id).map((r) => [r.affinity_row_id!, r.deal_id]),
  );
  const nextCompanyId = makeAllocator('C', new Set(existingCompanies.map((r) => r.company_id)));
  const nextDealId = makeAllocator('P', new Set(existingDeals.map((r) => r.deal_id)));

  // Deterministic allocation order: Affinity's own entity id ascending. Array
  // order from the API is not guaranteed stable, and allocating from it would
  // reshuffle every display id on a rebuild.
  const ordered = [...entries].sort((a, b) => a.entity.id - b.entity.id);

  await client.query('begin');
  try {
    await client.query('set local search_path = pc, public');

    for (const entry of ordered) {
      const { company, deal } = mapEntry(entry);

      // Status decides membership, funnel stage and terminality. An entry
      // without one is skipped and named rather than given an invented stage.
      if (deal.affinityStatus === '') {
        warnings.push({
          kind: 'data-quality',
          subject: `${deal.name} (entry ${deal.affinityRowId})`,
          field: 'Status',
          detail: 'No Status. Skipped: membership and funnel stage both derive from it.',
        });
        continue;
      }

      const funnelStageId = resolve(funnelStages, deal.affinityStatus, 'affinity_status_map');
      if (funnelStageId === null) {
        warnings.push({
          kind: 'unresolved-reference',
          subject: `${deal.name} (entry ${deal.affinityRowId})`,
          field: 'Status',
          detail:
            `"${deal.affinityStatus}" has no affinity_status_map row, and funnel_stage_id is NOT NULL. ` +
            'Re-run `npm run affinity:vocab` and re-seed, or map it in the table.',
        });
        continue;
      }

      /* THE MEMBERSHIP DECISION, in one place, from the table. `mapEntry`
         returns the company shape for every entry carrying a Status and leaves
         this to the caller (ADR-036); what makes a row a portfolio company is
         `is_portfolio_member`, and nothing else. */
      const isMember = membership.get(deal.affinityStatus)?.is_portfolio_member === true;

      let companyId: string | null = null;
      if (company && isMember) {
        companyId = companyIdByOrg.get(company.affinityOrgId) ?? nextCompanyId();
        companyIdByOrg.set(company.affinityOrgId, companyId);
        await upsertCompany(client, companyId, company, { sectors, channels, users, resolve });
        bump('company');
        bump('company_tag', await syncTags(client, companyId, company));
        if (await upsertCompanyState(client, companyId, company)) bump('company_state');
      }

      const dealId = dealIdByRow.get(deal.affinityRowId) ?? nextDealId();
      dealIdByRow.set(deal.affinityRowId, dealId);
      await upsertDeal(client, dealId, deal, funnelStageId, companyId, {
        sectors,
        channels,
        users,
        resolve,
      });
      bump('pipeline_deal');
      bump('pipeline_deal_owner', await syncOwners(client, dealId, deal, users));
      bump('pipeline_deal_pass_reason', await syncPassReasons(client, dealId, deal));
    }

    // Rows the run did not see. Reported, never deleted -- see rule 3.
    const { rows: stale } = await client.query<{ deal_id: string; name: string }>(
      `select deal_id, name from pipeline_deal
        where affinity_row_id is not null and synced_at < $1 order by deal_id`,
      [startedAt],
    );
    for (const row of stale) {
      warnings.push({
        kind: 'unseen',
        subject: `${row.name} (${row.deal_id})`,
        field: 'pipeline_deal',
        detail: 'Not returned by this run. Left in place with a stale synced_at; nothing is deleted.',
      });
    }

    if (dryRun) await client.query('rollback');
    else await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  }

  for (const [what, values] of unresolved) {
    const isPerson = what.startsWith('app_user');
    warnings.push({
      kind: 'unresolved-reference',
      subject: what,
      field: 'name',
      detail:
        `${values.size} value(s) matched no row. ` +
        (isPerson
          ? 'The name is stored in the *_label column, so nothing is lost, but the foreign key ' +
            'is null until the person has an app_user row whose display_name matches. Granting ' +
            'one is an access decision (ADR-005) and is deliberately NOT something this sync ' +
            'does: a CRM field must never confer platform permissions. Values: '
          : 'Stored verbatim; no reference row is invented and nothing is coerced to a nearest ' +
            'neighbour (ADR-026). Values: ') +
        [...values].sort().join(', '),
    });
  }

  return {
    startedAt,
    entriesRead: entries.length,
    apiCalls: af.calls - callsBefore,
    counts,
    warnings,
  };
}

// ---------------------------------------------------------------------------

interface Refs {
  sectors: Map<string, number>;
  channels: Map<string, number>;
  users: Map<string, string>;
  resolve: <T>(map: Map<string, T>, label: string | null, what: string) => T | null;
}

async function upsertCompany(
  client: pg.Client,
  companyId: string,
  c: MappedCompany,
  { sectors, channels, users, resolve }: Refs,
): Promise<void> {
  await client.query(
    `insert into company (company_id, affinity_org_id, affinity_row_id, name, sector_id, sector_label,
                          source_channel_id, source_label, ceo_name, ceo_email, hq_city, hq_region,
                          hq_country, nb_region, description, website, year_founded,
                          cb_total_funding_usd, affinity_fmv, affinity_total_investment,
                          affinity_figures_as_of, owner_user_id, secondary_user_id,
                          owner_label, secondary_label,
                          last_email_date, last_meeting_date, created_by, synced_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             current_date,$21,$22,$23,$24,$25,$26,$27,now())
     on conflict (affinity_org_id) do update set
       affinity_row_id           = excluded.affinity_row_id,
       name                      = excluded.name,
       sector_id                 = excluded.sector_id,
       sector_label              = excluded.sector_label,
       source_channel_id         = excluded.source_channel_id,
       source_label              = excluded.source_label,
       ceo_name                  = excluded.ceo_name,
       ceo_email                 = excluded.ceo_email,
       hq_city                   = excluded.hq_city,
       hq_region                 = excluded.hq_region,
       hq_country                = excluded.hq_country,
       nb_region                 = excluded.nb_region,
       description               = excluded.description,
       website                   = excluded.website,
       year_founded              = excluded.year_founded,
       cb_total_funding_usd      = excluded.cb_total_funding_usd,
       affinity_fmv              = excluded.affinity_fmv,
       affinity_total_investment = excluded.affinity_total_investment,
       affinity_figures_as_of    = current_date,
       owner_user_id             = excluded.owner_user_id,
       secondary_user_id         = excluded.secondary_user_id,
       owner_label               = excluded.owner_label,
       secondary_label           = excluded.secondary_label,
       last_email_date           = excluded.last_email_date,
       last_meeting_date         = excluded.last_meeting_date,
       synced_at                 = now()`,
    [
      companyId,
      c.affinityOrgId,
      c.affinityRowId,
      c.name,
      resolve(sectors, c.sectorLabel, 'ref_sector'),
      c.sectorLabel,
      resolve(channels, c.sourceLabel, 'ref_source_channel'),
      c.sourceLabel,
      c.ceoName,
      c.ceoEmail,
      c.hqCity,
      // Affinity spells the province out; is_nb_based is generated from 'NB'.
      c.hqRegion === 'New Brunswick' ? 'NB' : c.hqRegion,
      c.hqCountry === 'Canada' ? 'CA' : c.hqCountry,
      c.nbRegion,
      c.description,
      c.website,
      c.yearFounded,
      c.cbTotalFundingUsd,
      c.affinityFmv,
      c.affinityTotalInvestment,
      // A lead with no account resolves to null rather than failing the row;
      // the name is stored regardless, so nothing is lost.
      resolve(users, c.vcLeadName, 'app_user (VC Lead)'),
      resolve(users, c.vcSecondaryName, 'app_user (VC Secondary)'),
      c.vcLeadName,
      c.vcSecondaryName,
      c.lastEmailDate,
      c.lastMeetingDate,
      SYSTEM_USER_ID,
    ],
  );
}

/**
 * Health and lifecycle are DATED history (`company_state`), not columns, so a
 * board report can state health as at the reporting date rather than only
 * today's. A new row is opened only when something actually changed -- a
 * nightly sync that appended unconditionally would bury real transitions under
 * 347 identical rows a day.
 */
async function upsertCompanyState(client: pg.Client, companyId: string, c: MappedCompany): Promise<boolean> {
  /* `rosterStatus` joins the guard, and it is the one field here that is never
     null for a company the sync writes -- membership derives from it. Left out,
     a company whose only Affinity fact is its Status would get no state row at
     all, and ADR-036's derivation would read the exit event instead. */
  if (
    c.health === null &&
    c.riskGrade === null &&
    c.lifecycleStatus === null &&
    c.rosterStatus === ''
  ) {
    return false;
  }

  const { rows } = await client.query<{
    company_state_id: string; health: string | null; risk_grade: string | null;
    lifecycle_status: string | null; roster_status: string | null;
  }>(
    `select company_state_id, health, risk_grade, lifecycle_status, roster_status
       from company_state where company_id = $1 and effective_to is null`,
    [companyId],
  );
  const current = rows[0];
  if (
    current &&
    current.health === c.health &&
    current.risk_grade === c.riskGrade &&
    current.lifecycle_status === c.lifecycleStatus &&
    /* ADR-036 clause 5's convergence property, extended to the new column: a
       second run must create zero rows. A status that has not changed must not
       append a dated row saying it did -- that would bury real transitions,
       which is the whole reason this comparison exists. */
    current.roster_status === c.rosterStatus
  ) {
    return false;
  }

  // Close the open row before opening the next: company_state_current_uq
  // permits exactly one per company.
  if (current) {
    await client.query(
      `update company_state set effective_to = current_date where company_state_id = $1`,
      [current.company_state_id],
    );
  }
  await client.query(
    `insert into company_state (company_id, effective_from, health, risk_grade, lifecycle_status,
                                roster_status, set_by, note)
     values ($1, current_date, $2, $3, $4, $5, $6, 'Affinity sync')`,
    [companyId, c.health, c.riskGrade, c.lifecycleStatus, c.rosterStatus, SYSTEM_USER_ID],
  );
  return true;
}

async function upsertDeal(
  client: pg.Client,
  dealId: string,
  d: MappedDeal,
  funnelStageId: number,
  convertedCompanyId: string | null,
  { sectors, channels, users, resolve }: Refs,
): Promise<void> {
  await client.query(
    `insert into pipeline_deal (deal_id, affinity_row_id, name, sector_id, sector_label,
                                funnel_stage_id, funnel_label, source_channel_id, source_label,
                                owner_label, check_size, vc_lead_user_id, vc_secondary_user_id,
                                date_added, follow_up_date, stage_changed_date, last_email_date,
                                last_meeting_date, converted_company_id, synced_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now())
     on conflict (affinity_row_id) do update set
       name                 = excluded.name,
       sector_id            = excluded.sector_id,
       sector_label         = excluded.sector_label,
       funnel_stage_id      = excluded.funnel_stage_id,
       funnel_label         = excluded.funnel_label,
       source_channel_id    = excluded.source_channel_id,
       source_label         = excluded.source_label,
       owner_label          = excluded.owner_label,
       check_size           = excluded.check_size,
       vc_lead_user_id      = excluded.vc_lead_user_id,
       vc_secondary_user_id = excluded.vc_secondary_user_id,
       date_added           = excluded.date_added,
       follow_up_date       = excluded.follow_up_date,
       stage_changed_date   = excluded.stage_changed_date,
       last_email_date      = excluded.last_email_date,
       last_meeting_date    = excluded.last_meeting_date,
       converted_company_id = excluded.converted_company_id,
       synced_at            = now()`,
    [
      dealId,
      d.affinityRowId,
      d.name,
      resolve(sectors, d.sectorLabel, 'ref_sector'),
      d.sectorLabel,
      funnelStageId,
      // The VERBATIM Affinity status, so a renamed or deleted option degrades
      // to text rather than breaking the key (ADR-026).
      d.affinityStatus,
      resolve(channels, d.sourceLabel, 'ref_source_channel'),
      d.sourceLabel,
      d.ownerLabel ?? '-',
      d.checkSize,
      resolve(users, d.vcLeadName, 'app_user (VC Lead)'),
      resolve(users, d.vcSecondaryName, 'app_user (VC Secondary)'),
      d.dateAdded,
      d.followUpDate,
      d.stageChangedDate,
      d.lastEmailDate,
      d.lastMeetingDate,
      convertedCompanyId,
    ],
  );
}

/**
 * Owners ACCUMULATE in Affinity -- three consecutive adds with no deletes were
 * observed on one deal -- so the platform mirrors the whole list rather than
 * picking one (ADR-009). Removed owners are deleted here, because unlike a
 * company this list has no platform-owned children to protect and a stale
 * owner is actively misleading about who is on a deal.
 *
 * Keyed on Affinity's Person entity id, which survives a rename and the entity
 * merging that makes a primary email unreliable.
 */
async function syncOwners(
  client: pg.Client,
  dealId: string,
  d: MappedDeal,
  users: Map<string, string>,
): Promise<number> {
  for (const owner of d.owners) {
    await client.query(
      `insert into pipeline_deal_owner (deal_id, user_id, affinity_person_id, owner_name)
       values ($1,$2,$3,$4)
       on conflict (deal_id, affinity_person_id) do update set
         user_id = excluded.user_id, owner_name = excluded.owner_name, synced_at = now()`,
      [dealId, users.get(owner.name) ?? null, owner.affinityPersonId, owner.name],
    );
  }
  await client.query(
    `delete from pipeline_deal_owner where deal_id = $1 and not (affinity_person_id = any($2::bigint[]))`,
    [dealId, d.owners.map((o) => o.affinityPersonId)],
  );
  return d.owners.length;
}

async function syncPassReasons(client: pg.Client, dealId: string, d: MappedDeal): Promise<number> {
  for (const reason of d.passReasons) {
    await client.query(
      `insert into pipeline_deal_pass_reason (deal_id, reason_text, dropdown_option_id)
       values ($1,$2,$3)
       on conflict (deal_id, reason_text) do update set
         dropdown_option_id = excluded.dropdown_option_id, synced_at = now()`,
      [dealId, reason.text, reason.optionId],
    );
  }
  await client.query(
    `delete from pipeline_deal_pass_reason where deal_id = $1 and not (reason_text = any($2::text[]))`,
    [dealId, d.passReasons.map((r) => r.text)],
  );
  return d.passReasons.length;
}

/**
 * Tags are replaced per SOURCE, never wholesale: `manual` rows are someone's
 * work and a sync must not touch them.
 */
async function syncTags(client: pg.Client, companyId: string, c: MappedCompany): Promise<number> {
  for (const tag of c.tags) {
    await client.query(
      `insert into company_tag (company_id, tag, source, synced_at)
       values ($1,$2,$3,now())
       on conflict (company_id, source, tag) do update set synced_at = now()`,
      [companyId, tag.tag, tag.source],
    );
  }
  for (const source of ['priority-sector', 'product-service-industry']) {
    await client.query(
      `delete from company_tag
        where company_id = $1 and source = $2 and not (tag = any($3::text[]))`,
      [companyId, source, c.tags.filter((t) => t.source === source).map((t) => t.tag)],
    );
  }
  return c.tags.length;
}
