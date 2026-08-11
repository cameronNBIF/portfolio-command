'use client';

/**
 * In-memory edits to JUDGEMENT fields.
 *
 * ADR-018 draws the line this provider sits on. Financial rows -- transactions,
 * valuation marks, LP cashflows -- are append-only and are corrected by
 * reversal or supersession, never edited; nothing here touches them. Records
 * that represent judgement rather than fact -- diligence gates, reserve
 * allocations, health, flags, milestones -- are freely editable with an audit
 * trail, and these are two of those.
 *
 * A2 has no persistence: edits live for the session, exactly as the prototype
 * behaved before "Save locally". A3 replaces this with API writes that land in
 * `audit_log`, which is where the trail ADR-018 requires actually comes from.
 * The shape stays the same, so the components above do not change.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import type { PipelineDeal, PortfolioExport } from '@portfolio-command/contract';

interface EditableState {
  /** Pipeline with any gate edits applied. */
  pipeline: PipelineDeal[];
  setGate: (dealId: string, gateIndex: number, status: string) => void;
  /** Reserve allocation overrides, keyed by company id. Undefined means untouched. */
  reserveOverrides: Record<string, number>;
  setReserve: (companyId: string, allocated: number) => void;
  /** True once anything has been edited, so a view can say so. */
  dirty: boolean;
}

const EditableContext = createContext<EditableState | null>(null);

export function useEditable(): EditableState {
  const ctx = useContext(EditableContext);
  if (!ctx) throw new Error('useEditable must be used inside <EditableProvider>');
  return ctx;
}

export function EditableProvider({ db, children }: { db: PortfolioExport; children: ReactNode }) {
  const [pipeline, setPipeline] = useState<PipelineDeal[]>(db.pipeline);
  const [reserveOverrides, setReserveOverrides] = useState<Record<string, number>>({});
  const [dirty, setDirty] = useState(false);

  const setGate = useCallback((dealId: string, gateIndex: number, status: string) => {
    setPipeline((prev) =>
      prev.map((d) =>
        d.id === dealId ? { ...d, gates: d.gates.map((g, i) => (i === gateIndex ? { ...g, status } : g)) } : d,
      ),
    );
    setDirty(true);
  }, []);

  const setReserve = useCallback((companyId: string, allocated: number) => {
    // The prototype clamped at zero and fell back to 0 on an unparseable value.
    setReserveOverrides((prev) => ({ ...prev, [companyId]: Math.max(0, allocated || 0) }));
    setDirty(true);
  }, []);

  const value = useMemo<EditableState>(
    () => ({ pipeline, setGate, reserveOverrides, setReserve, dirty }),
    [pipeline, setGate, reserveOverrides, setReserve, dirty],
  );

  return <EditableContext.Provider value={value}>{children}</EditableContext.Provider>;
}
