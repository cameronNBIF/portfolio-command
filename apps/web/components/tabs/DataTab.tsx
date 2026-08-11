'use client';

/**
 * Data: schema, import and export. Ported from `renderData`
 * (vc-toolkit.html :1322-1423).
 *
 * The schema documentation and CSV specs are the valuable half of this tab --
 * they ARE the ADR-001 contract, and Daniel's export → edit → re-import loop
 * is written against them. Export works today, straight from the fixture.
 *
 * Import does not, and is shown as unavailable rather than faked. A2 renders
 * from a read-only static fixture; there is nothing to import into. It arrives
 * at A3 with the API, where ADR-001 also requires that derived fields in an
 * uploaded file are treated as ADVISORY -- a file asserting `invested: 8.5`
 * against transactions summing to 8.3 is corrected to 8.3 and returns a
 * reconciliation warning (D-1).
 */
import type { PortfolioExport } from '@portfolio-command/contract';

import { CSV_SPECS, JSON_SCHEMA_EXAMPLE, METRIC_CONVENTIONS } from '../../lib/schema-docs';
import { useApp } from '../AppShell';
import { Card, Pill, ViewHeader } from '../ui';

export function DataTab({ db, asOf }: { db: PortfolioExport; asOf: string }) {
  const { toast } = useApp();

  const download = (name: string, content: string, type: string) => {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${name}`);
  };

  return (
    <>
      <ViewHeader
        title="Data: Schema, Import &amp; Export"
        sub="The JSON schema below is the frozen contract (ADR-001). The API will emit exactly this shape, field for field, so an export taken today stays importable."
      />

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Card title="Export">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn sm"
              onClick={() => download('portfolio_command_data.json', JSON.stringify(db, null, 2), 'application/json')}
            >
              Export full JSON
            </button>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            Emits the contract shape exactly: money in $M, percentages as plain numbers, dates as YYYY-MM-DD. Currently
            reading the committed seed fixture, marks as at {asOf}. {db.companies.length} companies,{' '}
            {db.fundInvestments.length} LP positions, {db.pipeline.length} pipeline deals.
          </div>
        </Card>

        <Card title="Import">
          <div className="small" style={{ marginBottom: 8 }}>
            <b>Not available in this build.</b> The application currently renders from a read-only seed fixture, so
            there is nothing to import into.
          </div>
          <div className="hint">
            Import arrives with the API. All three routes the prototype offers are preserved: full JSON (exact structure
            of &ldquo;Export full JSON&rdquo;), per-entity CSV using the column specs below, and an Affinity list export
            with auto-detected columns. On import, fields the platform derives are treated as <b>advisory</b> — a file
            that disagrees with the transactions behind it is corrected, and the response names the discrepancy rather
            than silently accepting either figure.
          </div>
        </Card>
      </div>

      <Card title="CSV Column Specs" style={{ marginTop: 14 }}>
        {Object.entries(CSV_SPECS).map(([name, cols]) => (
          <div key={name} style={{ marginBottom: 8 }}>
            <Pill tone="blue">{name}.csv</Pill>
            <div className="mono small" style={{ marginTop: 3 }}>
              {cols}
            </div>
          </div>
        ))}
        <div className="hint">
          bools: Y/N - health: green|yellow|red - board_seat: Director|Observer|None - money in $M - percentages as
          numbers (11.2 = 11.2%) - dates YYYY-MM-DD
        </div>
      </Card>

      <Card title="JSON Schema (annotated example)" style={{ marginTop: 14 }}>
        <pre className="schema">{JSON_SCHEMA_EXAMPLE}</pre>
        <div className="hint">Metric conventions: {METRIC_CONVENTIONS}</div>
        <div className="hint" style={{ marginTop: 8 }}>
          Two presentation changes from the prototype, both forced by the data rather than by taste. Revenue is the
          period actual as reported through Visible and is labelled quarterly rather than run-rate; the arithmetic is
          unchanged. And the diversity figures distinguish &ldquo;not reported&rdquo; from zero, showing coverage
          alongside the metric — reporting 0% when the truth is &ldquo;not asked&rdquo; would be a worse error than
          reporting nothing.
        </div>
      </Card>
    </>
  );
}
