-- =====================================================================
-- 0006 · F0 — Finance groundwork: the frozen Affinity baseline, and
--        instrument classification on the transaction
--
-- Two changes, both additive, neither of which moves a number today.
-- That is the whole character of F0: it is the phase that buys options
-- for F1 to F6 and takes the one snapshot that becomes impossible to
-- take later.
--
--   1. affinity_control_snapshot — a write-once freeze of Affinity's
--      per-company invested and FMV figures, taken BEFORE the platform
--      ever writes to Affinity (ADR-039). Populated by a script, not by
--      this migration; see the note in section 1.
--   2. transaction.instrument_id — what this cheque bought, as opposed
--      to what the round was denominated in. Nullable, unread, and
--      backfilled only where the evidence is already in the database.
--
-- NEITHER IS READ BY ANYTHING WHEN THIS MIGRATION LANDS. No view, no
-- metric, no export field, no golden master. That is deliberate and it
-- is what makes F0 an S rather than an M.
-- =====================================================================

set search_path = pc, public;

-- ---------------------------------------------------------------------
-- 1. THE FROZEN AFFINITY BASELINE (ADR-039, FR-02, Q-17)
--
-- `company.affinity_total_investment` and `company.affinity_fmv` are
-- doing three jobs at once today:
--
--   * the A6 generator's reconciliation anchor -- the synthetic spine is
--     asserted against them per company, to the cent, before the
--     generator will commit (ADR-030);
--   * the agreed A13 control totals, which is how Finance's loaded
--     history will be checked;
--   * and, per Q-17, the fields the platform will OVERWRITE with its own
--     calculated figure at cutover, after which they become read-only in
--     Affinity and the platform stops reading them.
--
-- The third job destroys the first two. AFTER THE OUTBOUND WRITE,
-- RECONCILING AGAINST THESE COLUMNS PROVES NOTHING: the platform would
-- be checking its arithmetic against its own output and would agree with
-- itself perfectly while being wrong. A13 must therefore tie to a copy
-- taken before the write, and the only safe moment to take that copy is
-- one that has already passed by the time anyone remembers to.
--
-- So it is taken now, at F0, months ahead of the phase that needs it.
-- This is the one irreversible thing in F0 and it is pure insurance.
--
-- WHY THE MIGRATION CREATES THE TABLE AND DOES NOT FILL IT. A migration
-- runs against an empty database in CI and against a freshly created
-- one in the test harness, where there are no companies and no figures
-- to freeze. A populate step embedded here would either do nothing
-- silently in those environments or fail the build in them, and neither
-- is what "assert the totals reconcile to the cent" is supposed to mean.
-- Population is `npm run snapshot:affinity-controls`, which asserts
-- against the agreed totals and refuses to write anything if they have
-- moved. See packages/db/src/snapshot-affinity-controls.ts.
-- ---------------------------------------------------------------------

create table affinity_control_snapshot (
  affinity_control_snapshot_id bigint primary key generated always as identity,

  -- 'pre-cutover baseline' is the one that matters. The column exists
  -- because a second label -- a re-take after a decision to widen the
  -- roster at F4, say -- is a foreseeable and legitimate thing to want,
  -- and it must be a new set of rows rather than an edit to these.
  snapshot_label     text not null,
  taken_at           timestamptz not null default now(),
  taken_by           uuid not null references pc.app_user,

  company_id         text not null references pc.company,
  affinity_org_id    text,

  -- VERBATIM, and stored beside the id rather than joined to. A company
  -- renamed in Affinity between now and A13 would otherwise reconcile
  -- under a name nobody recognises, and the rename itself -- which is a
  -- real event worth seeing during a control-total review -- would be
  -- invisible. Same reasoning as company.sector_label (ADR-026).
  company_name       text not null,

  -- DOLLARS, matching the columns they are copied from. Nullable
  -- because the source columns are: a company Affinity holds no figure
  -- for must be recorded as holding no figure, not as holding zero.
  total_investment   numeric(18,2),
  fmv                numeric(18,2),

  note               text
);

-- One row per company per snapshot. This is also what makes the
-- populate script idempotent-by-refusal rather than idempotent-by-upsert,
-- which is the correct behaviour for a baseline: a second run against
-- drifted figures should fail loudly, not quietly restate the anchor.
create unique index affinity_control_snapshot_label_company_uq
  on affinity_control_snapshot (snapshot_label, company_id);

comment on table affinity_control_snapshot is
  'ADR-039. Affinity''s per-company invested and FMV figures frozen BEFORE the platform''s first outbound write at A13. A13 reconciles to this table, never to company.affinity_total_investment, which by then holds the platform''s own output. Write-once: see the guard trigger below.';
comment on column affinity_control_snapshot.company_name is
  'Verbatim at the moment of the snapshot. Stored rather than joined so a rename in Affinity between now and cutover is visible during the control-total review instead of being silently absorbed.';
comment on column affinity_control_snapshot.total_investment is
  'A copy of company.affinity_total_investment, which is VC-team-maintained reference data and has never entered a calculation (ADR-020). Its value here is as an independent anchor, and it only has that value because it was taken before we overwrote the original.';

-- WRITE-ONCE, ENFORCED RATHER THAN ASKED FOR.
--
-- The entire worth of this table is that nobody touched it between now
-- and A13. A comment saying so protects it from a careful reader; this
-- protects it from a tired one, and from a well-meant `update ... set
-- fmv = ...` issued to fix what looks like a stale figure and is in fact
-- the point.
--
-- Deliberately a hard refusal and not a soft one, which is the opposite
-- of how this codebase treats Finance's data entry -- a round total below
-- our own cheque is accepted and flagged, never refused, because pushing
-- someone into fudging a figure is worse than a visible wrong one. That
-- reasoning does not transfer. This table is not data entry: it is a
-- control artefact whose only property is immutability, and there is no
-- legitimate workflow that edits it. Correcting a snapshot taken wrongly
-- means dropping this trigger on purpose, which is the friction it is
-- there to create.
create function affinity_control_snapshot_is_immutable() returns trigger
language plpgsql as $$
begin
  raise exception
    'affinity_control_snapshot is write-once (ADR-039). It is the pre-cutover baseline A13 reconciles against, and an edited baseline reconciles to nothing. To retake it, insert a new snapshot_label. To correct one, drop this trigger deliberately and record why.'
    using errcode = 'restrict_violation';
end $$;

create trigger affinity_control_snapshot_immutable
  before update or delete on affinity_control_snapshot
  for each row execute function affinity_control_snapshot_is_immutable();

-- ---------------------------------------------------------------------
-- 2. WHAT THIS CHEQUE BOUGHT (part of S-5, ahead of FR-22 and FR-25)
--
-- `ref_instrument` has existed since 0001 and hangs off the ROUND, where
-- it is NOT NULL. That is right for the round -- a Series A is
-- denominated in something -- and it is not the same fact as what any
-- individual cheque bought.
--
-- The two commonly differ. A round can be funded with a note alongside
-- equity. A company can hold both an equity position and an outstanding
-- loan against it, which is exactly the case Pat described when he said
-- investments and loans are tracked separately on the balance sheet and
-- some portfolio companies have both.
--
-- NULL MEANS UNRECORDED AND IS NEVER DEFAULTED, on the ADR-030
-- precedent: the investment vehicle went in under the same rule, and two
-- roster companies genuinely have no vehicle attribution, where a
-- default would have attributed real deployment to a guess. The same
-- applies here with more at stake, because FR-25 will eventually split
-- the balance sheet on this column.
--
-- WHAT IS DELIBERATELY NOT HERE: the equity-versus-loan CATEGORISATION.
-- That needs Q-20 and SAFEs are genuinely ambiguous -- they are neither
-- straightforwardly. Capture the instrument now; classify it into
-- balance-sheet buckets when Pat has answered. Adding a column is cheap;
-- adding one that encodes a guess about how NBIF's statements treat a
-- SAFE is not.
-- ---------------------------------------------------------------------

alter table pc.transaction
  add column instrument_id int references pc.ref_instrument;

comment on column pc.transaction.instrument_id is
  'What this cheque bought. NOT the round''s instrument, though it usually matches: a round can be funded with a note alongside equity, and a company can hold both an equity position and an outstanding loan. NOT company.instrument_id either, which ADR-027 records as an independent headline fact rather than a derivation. NULL = unrecorded, never defaulted, on the ADR-030 precedent.';

create index on pc.transaction (instrument_id);

-- `v_transaction_live` IS DELIBERATELY NOT WIDENED. 0002 rewrote it with an
-- explicit column list precisely so that a later migration adding a column
-- could not silently widen a view the ADR-001 export reads from, and this is
-- the first migration since to add one. Nothing aggregates on instrument yet;
-- the Finance read path selects from `pc.transaction` directly. FR-25 will want
-- it in the view, and that is the change to make when there is something to
-- put in it.

-- THE BACKFILL, AND THE ONE PLACE IT IS ALLOWED TO LOOK.
--
-- From the LINKED ROUND, only where a link exists. Not from
-- `company.instrument_id`, which the 0001 schema comment explicitly
-- warns is an independent fact: C009 in the reference dataset reads
-- Debt-to-Note against a latest round of Preferred Equity, so inferring
-- a cheque's instrument from the company's headline one would write a
-- wrong answer into a column whose whole purpose is to be right about
-- individual cheques.
--
-- Everything else stays NULL, and that is the honest outcome rather than
-- a gap to be closed. On the A6 dataset that is 180 of 284 transactions
-- backfilled and 104 left unrecorded -- LP cashflows, which have no
-- instrument, and direct cheques nothing has ever linked to a round,
-- which is finding S-1 and is F1's job to fix.
--
-- WHY THE VERSION TRIGGER IS OFF FOR THIS STATEMENT, which is the only
-- judgement call in this migration.
--
-- `zz_version_transaction` fires on every UPDATE and it would fire on
-- all 180 rows here. Two consequences, and the second is the one that
-- decides it:
--
--   * 180 rows in financial_row_version describing a migration. Noise,
--     but arguably honest noise, and the table is designed never to be
--     pruned.
--   * `new.row_updated_at := now_ts`, unconditionally. The Finance
--     screen reads `row_updated_at > row_created_at` as "this row has
--     been edited since it was entered" and draws a pill. 180
--     transactions would claim, permanently and on screen, to have been
--     edited by someone. Nobody edited them.
--
-- That second failure is not hypothetical and it is not new: migrations
-- 0002 and 0003 both hit it and both solved it the same way, by
-- flattening `row_updated_at = row_created_at` after their backfills.
-- 0003's comment says so in as many words. Neither could reuse that fix
-- here, because in both cases the trigger was not yet attached and the
-- flattening UPDATE would itself fire it now.
--
-- So the precedent this codebase has already set twice -- a migration
-- backfill must not make a row look edited -- is honoured by scoping the
-- trigger off to exactly this statement, inside the migration's own
-- transaction.
--
-- THE ADR-031 GUARANTEE IS NOT WEAKENED, and the distinction is worth
-- stating precisely. That guarantee is about FINANCIAL FACTS: no dollar
-- figure, date, subject or classification changes without an attributed,
-- reconstructable version record. This statement changes none of those.
-- It copies a value that is already in the database, from a row the
-- transaction already points at, into a column that nothing reads. There
-- is no fact here for a version record to record that the round does not
-- already state, and the derivation is reproducible from the schema
-- alone. A one-time derivation of an added column is a different
-- operation from an edit, and it is the only case in which this is done.
--
-- The trigger is re-enabled below, in the same transaction, so a failure
-- anywhere in this migration leaves it on.

alter table pc.transaction disable trigger zz_version_transaction;

update pc.transaction t
   set instrument_id = r.instrument_id
  from pc.investment_round r
 where r.investment_round_id = t.investment_round_id
   and t.instrument_id is null;

alter table pc.transaction enable trigger zz_version_transaction;
