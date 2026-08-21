'use client';

/**
 * The Finance entry interfaces (A7).
 *
 * A NINTH TAB, where ADR-014 froze eight. That is not a violation of it: ADR-014
 * governs the one-to-one port of the prototype, and the prototype has no data
 * entry at all — every figure in it is a literal in a JavaScript object. Stage 3
 * of the roadmap adds production workflows the prototype never had, and this is
 * the first of them. The eight ported tabs are untouched.
 *
 * ROLE-GATED to `finance` and `admin`, matching CAN_WRITE_FINANCIAL. The VC team
 * owns judgement, Finance owns the money (ADR-005), and a tab that appears but
 * refuses every action is a worse experience than one that is not there.
 *
 * THE INTERFACE IS EDIT, DELETE AND RESTORE (ADR-031), not the Correct and
 * Reverse that ADR-018 specified. Every change here is captured by a database
 * trigger with the actor, the reason and the complete prior row.
 *
 * THIS FILE IS THE SWITCHER AND NOTHING ELSE. It was 1,509 lines holding three
 * of the five surfaces inline while the other two already had files of their
 * own — an inconsistency that existed only because Transactions was written
 * first and everything after it was added where the last one ended. Each surface
 * now sits beside its siblings in this directory, and what is left here is the
 * list of them and the button bar that chooses one.
 */
import { useState } from 'react';

import type { PortfolioExport } from '@portfolio-command/contract';

import { ViewHeader } from '../../ui';
import { FmvReviewSurface } from './FmvReviewSurface';
import { LpSurface } from './LpSurface';
import { MarksSurface } from './MarksSurface';
import { SignificantInfluenceSurface } from './SignificantInfluenceSurface';
import { TransactionsSurface } from './TransactionsSurface';

type Surface = 'transactions' | 'marks' | 'review' | 'lp' | 'influence';

const SURFACES: { id: Surface; label: string }[] = [
  { id: 'transactions', label: 'Transactions' },
  { id: 'marks', label: 'Valuation Marks' },
  // F2. The semi-annual exercise, run from a screen rather than beside one
  // (FR-19). Beside the marks table rather than replacing it: this is the
  // review path, that is the register.
  { id: 'review', label: 'FMV Review' },
  { id: 'lp', label: 'LP Activity' },
  // F3, FR-21. The significant-influence schedule and the ownership entry
  // behind it. Beside the entry surfaces rather than on the Policies tab with
  // the threshold that drives it: what is set there is a rule, and this is the
  // work the rule produces -- a schedule Finance reads and a cap table Finance
  // maintains. Last because it is a consequence of the four before it.
  { id: 'influence', label: 'Significant Influence' },
];

export function FinanceTab({ db }: { db: PortfolioExport }) {
  const [surface, setSurface] = useState<Surface>('transactions');

  return (
    <>
      <ViewHeader
        title="Finance"
        sub="Transaction, valuation and LP entry. Every change is attributed and recorded."
      />
      <div className="fbar">
        {SURFACES.map((s) => (
          <button
            key={s.id}
            className={s.id === surface ? 'btn sm' : 'btn ghost sm'}
            onClick={() => setSurface(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {surface === 'transactions' && <TransactionsSurface db={db} />}
      {surface === 'marks' && <MarksSurface db={db} />}
      {surface === 'review' && <FmvReviewSurface db={db} />}
      {surface === 'lp' && <LpSurface db={db} />}
      {surface === 'influence' && <SignificantInfluenceSurface />}
    </>
  );
}
