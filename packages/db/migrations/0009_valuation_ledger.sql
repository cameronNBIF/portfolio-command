-- =====================================================================
-- 0009 · F2 — The valuation ledger
--
-- Closes finding S-3 and lands ADR-034, amending ADR-007. Four changes:
--
--   1. ref_fmv_retention_option — the constrained list Finance chooses
--      from, as a TABLE rather than a CHECK, so the list can change
--      without a migration.
--   2. valuation_mark records the adjustment that produced it:
--      adjustment_type, basis_mark_id, basis_fmv, retention_factor,
--      adjustment_amount. `fmv` is unchanged and still the absolute.
--   3. The same-date unique index relaxes to one REVIEW mark per
--      company per date (S-3).
--   4. company_fmv_asof gains a deterministic tiebreak.
--
-- ADJUSTMENT IN, ABSOLUTE OUT, BOTH PERSISTED. Finance asked to enter
-- FMV as an adjustment against the last known value rather than as a new
-- absolute. That is a question about ENTRY, not about storage, and
-- ADR-034 satisfies it without touching what is stored -- the same move
-- ADR-031 made when it dropped append-only entry while keeping the
-- reproducibility guarantee underneath.
--
-- WHY NOT A DELTA CHAIN, which is what "record adjustments, not
-- absolutes" literally asks for. `company_fmv_asof()` is the definition
-- of NAV, and therefore of TVPI, RVPI and IRR. Under a pure delta chain
-- every read recomputes a running sum from the beginning of a company's
-- life, and one corrected early row silently shifts every figure after
-- it. That is a large change to the most load-bearing function in the
-- system in exchange for a data-entry convenience.
--
-- NO NUMBER MOVES. Every existing mark keeps its `fmv` to the cent and
-- is labelled `legacy`. Both index changes were checked against the data
-- before being written: there are zero same-date final pairs and zero
-- (effective_date, booked_at) ties in the database, so neither the
-- relaxation nor the new tiebreak can reorder anything that exists.
-- =====================================================================

set search_path = pc, public;

-- ---------------------------------------------------------------------
-- 1. THE RETENTION VOCABULARY (ADR-034 clause 4, FR-18)
--
-- A TABLE RATHER THAN A CHECK CONSTRAINT, and this is the one place in
-- F2 where the 0001 schema rule -- extensible lists in tables, small
-- fixed sets in CHECK -- points at a table for something that looks
-- fixed. The meeting's intent was a constrained list rather than free
-- entry, and that is preserved. What changes is WHO CAN CHANGE THE LIST:
-- Finance edits it through the Policies surface (F3, FR-21) instead of
-- asking for a migration.
--
-- Contrast `adjustment_type` in section 2, which stays a CHECK: each of
-- its values names a distinct write path in application code, so a value
-- nobody has written code for would be a value nothing can produce. That
-- is a closed set by construction. This one is not.
--
-- A FACTOR, NOT A PERCENTAGE, and the distinction is the whole reason
-- this column is `numeric(6,4)` and not `int`. `0.7500` means the
-- position is carried at 75% of its previous FMV. A factor has exactly
-- one arithmetic meaning -- new = prior x factor -- and cannot be read
-- backwards. `75` can, and the meeting itself showed how easily: FR-18
-- needed an explicit ruling that the number is RETAINED value rather
-- than the size of the write-down. Store the factor, display the
-- sentence.
-- ---------------------------------------------------------------------

create table ref_fmv_retention_option (
  fmv_retention_option_id serial primary key,

  -- The number the arithmetic uses. Unique because two rows offering the
  -- same factor under different labels is a choice with no meaning.
  factor      numeric(6,4) not null unique
                check (factor > 0 and factor <= 1),

  -- What the review screen says. Written as the sentence Finance used in
  -- the meeting, both halves of it, because "75%" alone is the ambiguity
  -- FR-18 had to resolve.
  label       text not null,

  -- Retired rather than deleted. A factor that has been used is
  -- referenced by marks that must keep reconstructing, and F6 reads the
  -- active set to check that a stored factor was legal when it was
  -- written.
  is_active   boolean not null default true,
  sort_order  int not null default 0
);

comment on table ref_fmv_retention_option is
  'ADR-034 clause 4, FR-18. The constrained list of retention factors the semi-annual review offers. A table rather than a CHECK so Finance can add or retire an option through the Policies surface (F3) without a migration. Rows are RETIRED via is_active, never deleted: a factor already used is referenced by marks that must keep reconstructing.';
comment on column ref_fmv_retention_option.factor is
  'RETAINED value as a factor, not the size of the write-down. 0.7500 = the position is carried at 75% of its previous FMV, a 25% impairment. new_fmv = prior_fmv * factor.';

insert into ref_fmv_retention_option (factor, label, sort_order) values
  (1.0000, 'Retain 100% of existing FMV — reviewed, no change', 10),
  (0.7500, 'Retain 75% of existing FMV — a 25% decrease',       20),
  (0.5000, 'Retain 50% of existing FMV — a 50% decrease',       30),
  (0.2500, 'Retain 25% of existing FMV — a 75% decrease',       40);

-- THERE IS DELIBERATELY NO 0% ROW. FR-18's list is 100 / 75 / 50 / 25,
-- and the absence confirms the reading that writing a position to nil is
-- the wind-down path (FR-28, F4) rather than an impairment. Whether
-- Finance also wants to mark a company worthless BEFORE it formally
-- winds up is Q-19, and it is now a one-row insert through the Policies
-- surface rather than a migration -- which is most of the argument for
-- this being a table.

-- ---------------------------------------------------------------------
-- 2. A MARK RECORDS THE ADJUSTMENT THAT PRODUCED IT (ADR-034)
--
-- `fmv` IS UNCHANGED AND STAYS THE FACT. Everything that reads FMV today
-- -- company_fmv_asof, v_company_current, the ADR-001 export, every
-- metric and every golden master -- keeps working untouched. That
-- property is what makes this affordable rather than a rewrite, and it
-- is why the columns below are additive and nullable.
--
-- ON ADR-002, WHICH SAYS DERIVED VALUES ARE NEVER STORED. `fmv` on a
-- review mark is computed from basis_fmv x retention_factor, so it looks
-- like a stored derivation. It is not being introduced as one: `fmv` was
-- already the stored fact and remains it, and ADR-034 is explicit that
-- keeping it that way rather than moving to a delta chain is the
-- decision. What the rule does govern is the OTHER direction, and it is
-- enforced below: each type stores its INPUT and never its derivation.
-- A review stores the factor and leaves adjustment_amount NULL, because
-- the amount is exactly fmv - basis_fmv and storing it would be storing
-- a sum. A transaction-driven mark, when Q-3 is answered, will do the
-- reverse.
-- ---------------------------------------------------------------------

alter table pc.valuation_mark
  -- WHAT CAUSED THIS MARK. A CHECK rather than a reference table: every
  -- value names a distinct write path in application code, so the set is
  -- closed by construction and an unlisted value would be one nothing
  -- can produce. See section 1 for the contrast.
  --
  -- FIVE OF THE EIGHT ARE DECLARED AND WRITTEN BY NOTHING, on purpose.
  -- `transaction` and `round_reprice` wait on Q-2, Q-3 and Q-4 -- all
  -- three are about WHICH ROWS GET WRITTEN and BY WHAT PROCESS, and none
  -- of them changes the shape of a row, which is the whole reason F2 can
  -- land ahead of the answers. `initial` and `realization` are the same
  -- shape of wait (Q-12 for the second). `write_off` is F4's wind-down
  -- path. Declaring them now costs nothing and means the vocabulary does
  -- not have to be reopened by a migration for each one.
  add column adjustment_type text not null default 'manual',
  add constraint mark_adjustment_type_known check (adjustment_type in (
    'review',         -- the semi-annual exercise. Retention factor. BUILT IN F2
    'manual',         -- free-entry absolute. Backfill and exceptions. BUILT IN F2
    'legacy',         -- pre-F2 rows, labelled by this migration's backfill
    'initial',        -- first investment, held at cost. Declared only
    'transaction',    -- an investment or follow_on is booked. Q-3, Q-4
    'round_reprice',  -- a priced round is captured. Q-2, Q-4
    'realization',    -- an exit. Q-12
    'write_off')),    -- wind-down. F4, FR-28

  -- The mark this one was applied to, and ITS FMV AT THE TIME THIS ROW
  -- WAS WRITTEN.
  --
  -- `basis_fmv` IS STORED RATHER THAN LOOKED UP, and that is the single
  -- most deliberate line in this migration. Under a lookup, correcting a
  -- 2019 mark silently invalidates the arithmetic of every mark after it
  -- and nothing says so. Stored, the same correction becomes a
  -- DETECTABLE condition -- basis_fmv no longer matching its
  -- predecessor's current fmv -- which F6 reports as a line on the
  -- reconciliation screen instead of a number nobody can explain.
  --
  -- basis_mark_id is nullable AND basis_fmv is still required on a
  -- review, which is the one asymmetry here and it is deliberate.
  --
  -- ADR-007 holds a company with no mark yet AT COST, so cost is its
  -- carrying value -- there is always a basis, but there is not always a
  -- basis ROW. The first review of a company between its first cheque
  -- and its first formal mark is an ordinary thing to want, and the
  -- alternative is Finance working out cost x 0.75 by hand and typing it
  -- as an absolute, which is precisely the re-entry FR-19 exists to
  -- remove. So `basis_mark_id is null, basis_fmv = 41000.00` is a legal
  -- and meaningful row: reviewed against cost.
  add column basis_mark_id bigint references pc.valuation_mark,
  add column basis_fmv numeric(18,2) check (basis_fmv is null or basis_fmv >= 0),

  -- The INPUT on a review. Not constrained to the reference table by a
  -- foreign key: the options are editable and retirable, and a mark
  -- written under a factor later retired must keep reconstructing
  -- exactly as issued. Validation is server-side against the ACTIVE rows
  -- at write time, which is the moment the question "is this a legal
  -- choice" actually has an answer.
  add column retention_factor numeric(6,4)
                check (retention_factor is null
                       or (retention_factor > 0 and retention_factor <= 1)),

  -- The INPUT on a transaction-driven mark, when Q-3 is answered. NULL
  -- on every path F2 builds. Signed: a realization reduces FMV.
  add column adjustment_amount numeric(18,2),

  -- ADR-002, made mechanical. A review's amount is fmv - basis_fmv and a
  -- transaction's factor is fmv / basis_fmv; each type may store the one
  -- it was GIVEN and never the one it can work out. Without this the two
  -- columns drift into being filled in "for convenience" and the first
  -- disagreement between a stored derivation and its inputs is a board
  -- number nobody can reconcile.
  add constraint mark_review_stores_its_input check (
    adjustment_type <> 'review'
    or (retention_factor is not null
        and adjustment_amount is null
        -- A review always knows what it was applied to, even when that
        -- was cost rather than an earlier mark. Without this a review
        -- could store a factor with nothing to multiply, and `fmv` would
        -- be the only surviving evidence of how it was reached.
        and basis_fmv is not null)),

  -- The reverse: nothing but a review may carry a factor. Keeps the
  -- column from becoming a general-purpose note.
  add constraint mark_factor_is_review_only check (
    retention_factor is null or adjustment_type = 'review'),

  -- A NAMED basis must carry its value. The reverse is allowed: a basis
  -- value with no row is a review against cost (see basis_mark_id
  -- above). What is forbidden is a row that claims to know which mark it
  -- was applied to and cannot say what that mark was worth, because that
  -- is the exact state clause 3 exists to make impossible.
  add constraint mark_basis_named_is_valued check (
    basis_mark_id is null or basis_fmv is not null);

comment on column pc.valuation_mark.adjustment_type is
  'ADR-034. What caused this mark. `review` and `manual` are the two paths F2 builds; `legacy` labels every row that predates F2. The rest are declared and written by nothing -- `transaction` and `round_reprice` wait on Q-2/Q-3/Q-4, `realization` on Q-12, `write_off` on F4. They are in the vocabulary now because none of those answers changes the shape of a row, only which rows get written.';
comment on column pc.valuation_mark.basis_fmv is
  'ADR-034 clause 3. The basis mark''s FMV AT THE TIME THIS ROW WAS WRITTEN, stored rather than looked up. A later correction to an earlier mark therefore becomes a detectable inconsistency -- this value no longer matching its predecessor -- rather than silently invalidating every mark downstream. F6 reports the mismatch.';
comment on column pc.valuation_mark.retention_factor is
  'RETAINED value. 0.7500 = carried at 75% of the basis, a 25% impairment. The INPUT to a review; `fmv` is the result and is computed server-side, never accepted from the client (ADR-034 clause 2).';
comment on column pc.valuation_mark.adjustment_amount is
  'The INPUT to a transaction-driven mark, when Q-3 is answered. NULL on every path F2 builds. Never populated for a review, where the amount is fmv - basis_fmv and storing it would be storing a sum (ADR-002).';

create index on pc.valuation_mark (adjustment_type);
create index on pc.valuation_mark (basis_mark_id);

-- THE BACKFILL, and the same trigger argument F0 and F1 both made.
--
-- Every existing mark becomes `legacy`, which is the honest label: these
-- rows were written before the ledger existed and nothing is known about
-- how their figures were arrived at beyond the rationale each carries.
-- They are NOT relabelled `manual`, which would assert that somebody
-- typed an absolute through the free-entry path -- true of some of them
-- and unknowable for the rest.
--
-- `zz_version_valuation_mark` is scoped off for the statement. It sets
-- `new.row_updated_at := now_ts` unconditionally, and the Finance screen
-- reads row_updated_at > row_created_at as "edited since entered" and
-- draws a pill; 1,016 marks would claim on screen to have been edited by
-- someone. The ADR-031 guarantee is untouched, on the same reading F0
-- and F1 recorded: this initialises a column added in the same
-- migration, by a rule stated in the same migration, and changes no
-- financial fact. Not one `fmv` moves.
--
-- The DEFAULT is 'manual' rather than 'legacy' because it applies to
-- rows written from here on, where free entry is what an unspecified
-- type means (ADR-034 clause 7). The backfill below is what makes the
-- existing rows say something different and truer.

alter table pc.valuation_mark disable trigger zz_version_valuation_mark;

update pc.valuation_mark set adjustment_type = 'legacy';

alter table pc.valuation_mark enable trigger zz_version_valuation_mark;

-- ---------------------------------------------------------------------
-- 3. ONE REVIEW PER COMPANY PER DATE, NOT ONE MARK (S-3, ADR-034 cl. 6)
--
-- The 0001 index permits one final mark per company per effective date.
-- It was written when a second mark on one date could only be a mistake.
-- It now blocks two follow-ons on one day, and it blocks a transaction
-- landing on 31 January -- which is a valuation date, so that collision
-- is not hypothetical. TWO CHEQUES ON ONE DAY ARE TWO FACTS, NOT A
-- CONFLICT.
--
-- What stays constrained is the review: the semi-annual exercise happens
-- once per company per cycle, and a second one on the same date is a
-- duplicate rather than a second fact.
--
-- IT ALSO GAINS `deleted_at is null`, WHICH IS A SEPARATE DEFECT FIXED
-- IN PASSING BECAUSE THE STATEMENT IS BEING REWRITTEN ANYWAY. The old
-- index does not exclude soft-deleted rows, while the application check
-- in writeValuationMark does -- so deleting a mark and entering another
-- at the same date passes validation and then fails on a constraint the
-- user cannot see, act on, or understand. `writeOwnership` in
-- rounds.ts already carries a comment about this exact hazard on
-- company_ownership. The two now agree.
--
-- CHECKED BEFORE WRITTEN: zero same-date final pairs exist in the
-- database, so nothing is admitted by this that was previously refused.
-- ---------------------------------------------------------------------

drop index pc.valuation_mark_active_uq;

create unique index valuation_mark_review_uq
  on pc.valuation_mark (company_id, effective_date)
  where status = 'final' and adjustment_type = 'review' and deleted_at is null;

comment on index pc.valuation_mark_review_uq is
  'S-3, ADR-034 clause 6. One REVIEW mark per company per effective date. Everything else may repeat -- two cheques on one day are two facts. Excludes soft-deleted rows so the index agrees with the check in writeValuationMark; the 0001 version did not, and the disagreement surfaced as a constraint error the operator could not act on.';

-- ---------------------------------------------------------------------
-- 4. A DETERMINISTIC TIEBREAK (ADR-034 clause 6, second half)
--
-- `company_fmv_asof` ordered by (effective_date desc, booked_at desc)
-- and stopped there, because when it was written a tie was impossible --
-- the index in section 3 guaranteed one final mark per date. Both halves
-- of that guarantee are now gone: several marks may share a date, and
-- `booked_at` defaults to now(), which is TRANSACTION START TIME, so two
-- marks written inside one database transaction carry the identical
-- timestamp. The order between them would be whatever the plan happened
-- to produce.
--
-- This is the function that defines NAV, and therefore TVPI, RVPI and
-- IRR. A non-deterministic ordering here is a board number that can
-- differ between two runs over identical data -- the exact failure
-- ADR-021 removed from the as-of date, reappearing one row down.
--
-- One line, and load-bearing from the moment same-day marks are legal.
-- Restated in full because Postgres cannot amend one clause of an
-- existing function body. Nothing else changes; with zero ties in the
-- data, no number moves.
-- ---------------------------------------------------------------------

create or replace function pc.company_fmv_asof(p_company_id text, p_as_of date)
returns numeric language sql stable as $$
  select coalesce(
    (select vm.fmv
       from pc.valuation_mark vm
      where vm.company_id = p_company_id
        and vm.status = 'final'
        and vm.deleted_at is null
        and vm.effective_date <= p_as_of
      order by vm.effective_date desc, vm.booked_at desc, vm.valuation_mark_id desc
      limit 1),
    (select coalesce(sum(t.amount_cad), 0)
       from pc.v_transaction_live t
      where t.company_id = p_company_id
        and t.txn_type in ('investment','follow_on')
        and t.txn_date <= p_as_of)
  );
$$;

comment on function pc.company_fmv_asof(text, date) is
  'ADR-007. FMV as at a date: the latest final, undeleted mark on or before it, falling back to cost. Ordered by effective_date, then booked_at, then valuation_mark_id -- the last term added at F2, because booked_at defaults to transaction start time and two marks written in one transaction tie on it. This function defines NAV, so a non-deterministic order here is a board number that changes between runs over identical data.';
