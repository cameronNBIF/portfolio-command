/**
 * `GET /api/v1/financial/history` — the verbose audit trail (ADR-031).
 *
 * Two shapes, chosen by whether `recordId` is present:
 *
 *   ?table=transaction&recordId=42   one row's complete history, oldest first,
 *                                    each entry carrying the field-level diff.
 *                                    Drives the History panel.
 *
 *   ?restatements=true               every change that moved a figure inside a
 *                                    period already issued to the board. The
 *                                    list ADR-031 clause 5 promises exists.
 *
 * Readable by all four roles. Who changed a number is not privileged
 * information inside a nine-person team — restricting it would only mean the
 * question gets asked in Teams instead, which is the outcome the log exists to
 * avoid.
 */
import { db, readRestatements, readRowHistory, ValidationError } from '@portfolio-command/api';

import { withPrincipal } from '../../../_lib/handler';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return withPrincipal(request, async (principal) => {
    const q = new URL(request.url).searchParams;

    if (q.get('restatements') === 'true') {
      const entries = await readRestatements(db(), principal);
      return { entries };
    }

    const table = q.get('table');
    const recordId = q.get('recordId');
    if (!table || !recordId) {
      throw new ValidationError(
        'Give "table" and "recordId" for one row\'s history, or "restatements=true" for every restatement.',
      );
    }
    const entries = await readRowHistory(db(), principal, table, recordId);
    return { entries };
  });
}
