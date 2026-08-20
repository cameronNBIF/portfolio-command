-- =====================================================================
-- 0007 · Two comments, and nothing else
--
-- ADR-039 was amended on 20 August 2026: the outbound write of total
-- invested to Affinity is NOT part of A13 and now has no date, because
-- the push depends on live history that Finance has verified, which is
-- an OUTPUT of A13 rather than a step within it.
--
-- 0006's comments on `affinity_control_snapshot` describe the table
-- purely as insurance against that write. That reading is now both
-- mis-sequenced and, worse, misleading about what the table is FOR: with
-- the write indefinite, a reader would reasonably conclude the table is
-- dead schema awaiting a phase that may never come, and the next person
-- to want the roster empty in a hurry would drop the trigger rather than
-- ask why it is there.
--
-- IT IS NOT DEAD SCHEMA. It is an A13 reconciliation artefact in its own
-- right, and the argument does not depend on the write at all: the
-- control totals were agreed at an INSTANT, while the columns holding
-- them are synced nightly and VC-team maintained. ADR-020 records how
-- volatile that makes them -- one deal's figure ran 1,000,000 -> 500,000
-- -> deleted -> 1,000,000 -> 1,500 -> 1,500,000, the fat-finger
-- corrected 33 seconds later. Without a frozen copy, "each batch
-- reconciles to Finance's control totals" is not a reproducible
-- instruction, because a failure at A13 cannot be distinguished from
-- Affinity having moved underneath it.
--
-- WHY A MIGRATION FOR A COMMENT. 0006 is applied and its checksum is
-- recorded; the runner refuses an edited file by design, and correctly
-- so. Comments in this schema are load-bearing -- they are what a DBA
-- reads at 9pm, and `\d+` is the only documentation available inside
-- psql. A comment that has quietly become wrong is worse than none.
--
-- No DDL. No data change. Safe to re-run.
-- =====================================================================

set search_path = pc, public;

comment on table affinity_control_snapshot is
  'ADR-039 clause A. The agreed A13 control totals, frozen at F0 (19 Aug 2026): Affinity''s per-company invested and FMV as they stood before any real financial history was loaded. A13 reconciles batch by batch to THIS TABLE, never to company.affinity_total_investment -- that column is synced nightly and VC-team maintained, so a reconciliation failure against it could not be told apart from Affinity having moved. Write-once, enforced against UPDATE, DELETE and TRUNCATE. Clause B, the outbound write this was originally raised alongside, is deferred past A13 with no date; it is NOT what this table is for.';

comment on column affinity_control_snapshot.total_investment is
  'A copy of company.affinity_total_investment, which is VC-team-maintained reference data and has never entered a calculation (ADR-020). Its worth is as an anchor fixed at the instant the control totals were agreed, against a live column that moves nightly.';
