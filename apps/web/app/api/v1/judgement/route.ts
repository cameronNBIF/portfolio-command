/**
 * `POST /api/v1/judgement` — edits to judgement records only (ADR-018).
 *
 * Gates, reserves and memos, plus the A9 surfaces: risk flags, per-company
 * thresholds, the fund alert policy and alert acknowledgements (ADR-032).
 * Financial rows are unreachable from here by construction, not by convention
 * -- see the note on `JudgementEdit`.
 *
 * HEALTH IS NOT HERE AND WILL NOT BE. Affinity is the system of record for the
 * risk grade behind it (ADR-009) and the sync is one-way; the VC team maintains
 * it there. The platform shows the rating, who set it and when, and offers no
 * way to overwrite it.
 *
 * Financial rows are edited through `/api/v1/financial` (A7, ADR-031), over a
 * versioned store with trigger-enforced history. The split between the two
 * endpoints is the ADR-018 fact/judgement boundary, which ADR-031 left intact:
 * what changed is the interface offered over facts, not which rows are facts.
 *
 * THE BODY PARSER IS NOT HERE ANY MORE, and neither is the second
 * `ValidationError` class this file used to declare for it. `parseJudgementEdit`
 * sits beside `applyJudgementEdit` and raises the package's own error type — the
 * local copy worked only because `handler.ts` matches by `name`.
 */
import { applyJudgementEdit, db, parseJudgementEdit } from '@portfolio-command/api';

import { jsonBody, withPrincipal } from '../../_lib/handler';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return withPrincipal(request, async (principal) => {
    const edit = parseJudgementEdit(await jsonBody(request));
    // The role check lives in applyJudgementEdit so it cannot be forgotten by a
    // second caller that does not go through this route.
    await applyJudgementEdit(db(), principal, edit);
    return { ok: true };
  });
}
