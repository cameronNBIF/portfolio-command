'use client';

/**
 * Investment Memo Builder, ported from `renderMemo` / `exportMemoMd`
 * (vc-toolkit.html :1167-1207).
 *
 * Sections auto-populate from portfolio or pipeline data and are then freely
 * editable -- a memo is a judgement record, not a financial fact (ADR-018).
 * Drafts are held in memory for the session, as the prototype held them before
 * "Save locally".
 */
import { useEffect, useMemo, useState } from 'react';

import type { PortfolioExport } from '@portfolio-command/contract';

import { useEditable } from '../../lib/editable';
import { AUTO_POPULATED, MEMO_SECTIONS, memoEntities, memoToMarkdown, prefillMemo, type Memo } from '../../lib/memo';
import { useApp } from '../AppShell';
import { Card, Pill, ViewHeader } from '../ui';

export function MemoTab({ db, asOf }: { db: PortfolioExport; asOf: string }) {
  const { memoTarget, setMemoTarget, toast } = useApp();
  const { pipeline } = useEditable();

  const entities = useMemo(() => memoEntities(db), [db]);
  const targetId = memoTarget && entities.some((e) => e.id === memoTarget) ? memoTarget : entities[0]?.id;

  const [drafts, setDrafts] = useState<Record<string, Memo>>({});

  // Prefill on first visit to an entity, as `renderMemo` did (:1172).
  useEffect(() => {
    if (!targetId) return;
    setDrafts((prev) => (prev[targetId] ? prev : { ...prev, [targetId]: prefillMemo(db, targetId, pipeline) }));
  }, [targetId, db, pipeline]);

  if (!targetId) return <div className="small">Nothing to draft against.</div>;

  const entity = entities.find((e) => e.id === targetId);
  const memo = drafts[targetId] ?? {};
  const title = entity ? entity.label.replace(/\s*\(.*/, '') : '';

  const setSection = (key: string, value: string) =>
    setDrafts((prev) => ({ ...prev, [targetId]: { ...(prev[targetId] ?? {}), [key]: value } }));

  const repull = () => {
    setDrafts((prev) => ({ ...prev, [targetId]: prefillMemo(db, targetId, pipeline) }));
    toast('Re-pulled data into memo');
  };

  const exportMd = () => {
    const md = memoToMarkdown(db.fund.name, entity?.label ?? '', memo, asOf);
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/\s+/g, '_')}_IM.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <ViewHeader
        title="Investment Memo Builder"
        sub="Deal terms, cap table, traction, and risks auto-populate from portfolio / pipeline data. Edit any section; export to Markdown or print."
      />

      <div className="fbar">
        <select value={targetId} onChange={(e) => setMemoTarget(e.target.value)}>
          {entities.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
        <button className="btn sm ghost" onClick={repull}>
          ↻ Re-pull data
        </button>
        <button className="btn sm" onClick={exportMd}>
          Export .md
        </button>
        <button className="btn sm ghost" onClick={() => window.print()}>
          Print / PDF
        </button>
        <span className="count">Memo drafts are held in memory for this session.</span>
      </div>

      <Card>
        <div style={{ borderBottom: '2px solid var(--navy)', paddingBottom: 8, marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>INVESTMENT MEMORANDUM - {title}</div>
          <div className="small">
            {db.fund.name} - {asOf} - CONFIDENTIAL
          </div>
        </div>
        {MEMO_SECTIONS.map(([key, label], i) => (
          <div className="memosec" key={key}>
            <label>
              {i + 1}. {label}{' '}
              {AUTO_POPULATED.has(key) && (
                <Pill tone="blue">
                  <span style={{ textTransform: 'none' }}>auto-populated</span>
                </Pill>
              )}
            </label>
            <textarea value={memo[key] ?? ''} onChange={(e) => setSection(key, e.target.value)} />
          </div>
        ))}
      </Card>
    </>
  );
}
