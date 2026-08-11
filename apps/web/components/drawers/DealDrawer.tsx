'use client';

/**
 * Pipeline deal drawer, ported from `openDeal` / `setGate`
 * (vc-toolkit.html :1097-1126).
 *
 * Diligence gates are editable in place. That is correct under ADR-018: a gate
 * is a JUDGEMENT record, not a financial fact, and judgement records are freely
 * editable with an audit trail. Nothing here can touch a transaction or a mark.
 */
import type { PipelineDeal } from '@portfolio-command/contract';
import { fmt } from '@portfolio-command/metrics';

import { GATE_STATUSES } from '../../lib/constants';
import { useEditable } from '../../lib/editable';
import { DrawerBody, DrawerHeader } from '../AppShell';
import { DrawerSection, Kv, KvGrid, Pill, Progress, type PillTone } from '../ui';

function gateTone(status: string): PillTone {
  return status === 'passed' ? 'green' : status === 'in-progress' ? 'blue' : status === 'failed' ? 'red' : 'gray';
}

export function DealDrawer({ deal: d }: { deal: PipelineDeal }) {
  const { setGate } = useEditable();
  const passed = d.gates.filter((g) => g.status === 'passed').length;

  const termSheetRows: [string, string][] = d.termSheet
    ? [
        ['Security', d.termSheet.security],
        ['Pre-money', fmt.m(d.termSheet.preMoney)],
        ['Post-money', fmt.m(d.termSheet.postMoney)],
        ['Our investment', fmt.m(d.termSheet.investment)],
        ['Ownership', fmt.pct(d.termSheet.ownership)],
        ['Liquidation preference', d.termSheet.liquidation],
        ['Anti-dilution', d.termSheet.antiDilution],
        ['Board composition', d.termSheet.board],
        ['Pro-rata rights', d.termSheet.proRata],
        ['Dividends', d.termSheet.dividends],
        ['Option pool', d.termSheet.optionPool],
        ['Founder vesting', d.termSheet.founderVesting],
      ]
    : [];

  return (
    <>
      <DrawerHeader>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 17, fontWeight: 700 }}>{d.name}</span>
          <Pill tone="blue">{d.funnel}</Pill>
        </div>
        <div className="small" style={{ marginTop: 3 }}>
          {d.sector} - Source: {d.source} - Owner: {d.owner} - Added {d.added}
        </div>
      </DrawerHeader>

      <DrawerBody>
        <DrawerSection>
          <KvGrid>
            <Kv label="PROPOSED CHECK" value={fmt.m(d.checkSize)} />
            <Kv label="VALUATION (POST)" value={d.valuation ? fmt.m(d.valuation) : 'TBD'} />
            <Kv
              label="IMPLIED OWNERSHIP"
              value={d.valuation && d.checkSize ? fmt.pct((d.checkSize / d.valuation) * 100) : 'TBD'}
            />
            <Kv label="NEXT STEP" value={<span style={{ fontWeight: 500 }}>{d.nextStep}</span>} />
          </KvGrid>
        </DrawerSection>

        {d.gates.length > 0 && (
          <DrawerSection title={`Diligence Gates (${passed}/${d.gates.length} passed)`}>
            <div style={{ marginBottom: 8 }}>
              <Progress pct={d.gates.length ? (passed / d.gates.length) * 100 : 0} />
            </div>
            {d.gates.map((g, i) => (
              <div className="gate" key={i}>
                <Pill tone={gateTone(g.status)}>{g.status}</Pill>
                <span style={{ flex: 1 }}>{g.name}</span>
                <select value={g.status} onChange={(e) => setGate(d.id, i, e.target.value)}>
                  {GATE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <div className="hint" style={{ marginTop: 6 }}>
              Gates are editable per deal; defaults defined in the Data tab schema. Edits are held in memory for this
              session.
            </div>
          </DrawerSection>
        )}

        {d.termSheet && (
          <DrawerSection title="Term Sheet Summary">
            <table className="dt">
              <tbody>
                {termSheetRows.map(([k, v]) => (
                  <tr key={k}>
                    <td className="small" style={{ width: 190 }}>
                      <b>{k}</b>
                    </td>
                    <td>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DrawerSection>
        )}
      </DrawerBody>
    </>
  );
}
