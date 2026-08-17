/**
 * `POST /api/v1/judgement` — edits to judgement records only (ADR-018).
 *
 * Gates, reserves and memos: the three surfaces A2's `editable.tsx` already
 * drives. Financial rows are unreachable from here by construction, not by
 * convention -- see the note on `JudgementEdit`.
 *
 * Financial rows are edited through `/api/v1/financial` (A7, ADR-031), over a
 * versioned store with trigger-enforced history. The split between the two
 * endpoints is the ADR-018 fact/judgement boundary, which ADR-031 left intact:
 * what changed is the interface offered over facts, not which rows are facts.
 */
import { applyJudgementEdit, db, type JudgementEdit } from '@portfolio-command/api';

import { withPrincipal } from '../../_lib/handler';

export const dynamic = 'force-dynamic';

class ValidationError extends Error {
  override name = 'ValidationError';
}

/**
 * Narrows the parsed body to a `JudgementEdit`.
 *
 * Hand-written rather than schema-generated: three shapes do not justify a
 * validation dependency, and the failure messages are better for being written
 * for the person reading them.
 */
function parseEdit(body: unknown): JudgementEdit {
  if (typeof body !== 'object' || body === null) throw new ValidationError('Body must be an object.');
  const b = body as Record<string, unknown>;
  const str = (k: string): string => {
    const v = b[k];
    if (typeof v !== 'string' || v === '') throw new ValidationError(`"${k}" must be a non-empty string.`);
    return v;
  };

  switch (b['kind']) {
    case 'deal-gate':
      return { kind: 'deal-gate', dealId: str('dealId'), gateName: str('gateName'), status: str('status') };
    case 'reserve-allocation': {
      const allocated = b['allocated'];
      if (typeof allocated !== 'number') throw new ValidationError('"allocated" must be a number ($M).');
      return { kind: 'reserve-allocation', companyId: str('companyId'), allocated };
    }
    case 'memo-section': {
      const bodyText = b['body'];
      if (typeof bodyText !== 'string') throw new ValidationError('"body" must be a string.');
      return { kind: 'memo-section', subjectId: str('subjectId'), sectionKey: str('sectionKey'), body: bodyText };
    }
    default:
      throw new ValidationError(
        '"kind" must be one of: deal-gate, reserve-allocation, memo-section. ' +
          'Financial records are append-only and are not editable through this endpoint (ADR-018).',
      );
  }
}

export async function POST(request: Request): Promise<Response> {
  return withPrincipal(request, async (principal) => {
    const edit = parseEdit(await request.json().catch(() => null));
    // The role check lives in applyJudgementEdit so it cannot be forgotten by a
    // second caller that does not go through this route.
    await applyJudgementEdit(db(), principal, edit);
    return { ok: true };
  });
}
