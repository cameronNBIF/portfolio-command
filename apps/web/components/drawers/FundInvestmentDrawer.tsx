'use client';

/**
 * LP position drawer, ported from `openFundInv` (vc-toolkit.html :1025-1060).
 *
 * Carries the third sanctioned ADR-014 content exception with it (F5, FR-33):
 * the three LP stages are named Committed Capital, Capital Drawdown and Capital
 * Distribution here as everywhere else, because Funke's point is that a capital
 * call is the GP's word for it and a drawdown is ours. Layout and behaviour are
 * the prototype's, unchanged. See ADR-014 and ADR-037.
 */
import type { FundInvestment } from '@portfolio-command/contract';
import { fiDpi, fiIrr, fiTvpi, fmt } from '@portfolio-command/metrics';

import { DrawerBody, DrawerHeader } from '../AppShell';
import { DrawerSection, Kv, KvGrid, Pill, moicClass } from '../ui';

export function FundInvestmentDrawer({ position: f, asOf }: { position: FundInvestment; asOf: string }) {
  const tvpi = fiTvpi(f);

  return (
    <>
      <DrawerHeader>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 17, fontWeight: 700 }}>{f.name}</span>
          <Pill tone="purple">LP POSITION</Pill>
        </div>
        <div className="small" style={{ marginTop: 3 }}>
          {f.manager} - {f.strategy} - Vintage {f.vintage} - Contact: {f.contact || '-'}
        </div>
      </DrawerHeader>

      <DrawerBody>
        <DrawerSection>
          <KvGrid>
            <Kv label="COMMITTED CAPITAL" value={fmt.m(f.committed)} />
            <Kv
              label="DRAWN"
              value={`${fmt.m(f.called)} (${f.committed > 0 ? fmt.pct0((f.called / f.committed) * 100) : '-'})`}
            />
            <Kv label="UNFUNDED" value={fmt.m(f.committed - f.called)} />
            <Kv label="NAV" value={fmt.m(f.nav)} />
            <Kv label="DISTRIBUTIONS" value={fmt.m(f.distributions)} />
            <Kv label="TVPI / DPI" value={`${fmt.x(tvpi)} / ${fmt.x(fiDpi(f))}`} valueClass={moicClass(tvpi)} />
            <Kv label="NET IRR" value={fmt.pct(fiIrr(f, asOf))} />
            <Kv label="NEXT DRAWDOWN (EST.) / AGM" value={`${fmt.d(f.nextCallEst)} / ${fmt.d(f.agm)}`} />
          </KvGrid>
        </DrawerSection>

        <DrawerSection title="Strategic Rationale">
          <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>{f.rationale || '-'}</div>
          <div className="badgebar" style={{ marginTop: 8 }}>
            {f.coInvestRights ? <Pill tone="green">Co-invest rights</Pill> : <Pill tone="gray">No co-invest rights</Pill>}
            <Pill tone="blue">
              {f.coInvestsDone || 0} co-invest{(f.coInvestsDone || 0) === 1 ? '' : 's'} completed
            </Pill>
            <Pill tone="teal">
              {f.referrals || 0} pipeline referral{(f.referrals || 0) === 1 ? '' : 's'}
            </Pill>
            <Pill tone="purple">{fmt.m(f.capitalToDirect || 0)} deployed into our direct portfolio</Pill>
            {f.womenSeniorGP && <Pill tone="green">Women in GP leadership</Pill>}
          </div>
        </DrawerSection>

        <DrawerSection title="Cashflow History (drawdowns negative, distributions positive)">
          <table className="dt">
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">Amount $M</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {(f.cashflows || []).length === 0 && (
                <tr>
                  <td colSpan={3} className="small">
                    No cashflows recorded.
                  </td>
                </tr>
              )}
              {(f.cashflows || []).map((c, i) => (
                <tr key={i}>
                  <td>{c.date}</td>
                  <td className={`num ${c.amount < 0 ? 'down' : 'up'}`}>
                    {c.amount < 0 ? '' : '+'}
                    {c.amount.toFixed(1)}
                  </td>
                  <td className="small">{c.amount < 0 ? 'Capital Drawdown' : 'Capital Distribution'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="hint" style={{ marginTop: 5 }}>
            IRR uses these flows plus current NAV as terminal value, dated {asOf}.
          </div>
        </DrawerSection>
      </DrawerBody>
    </>
  );
}
