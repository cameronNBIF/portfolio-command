'use client';

/**
 * The application. Eight tabs, ported one-to-one from the prototype (ADR-014),
 * rendering from the ADR-001 contract shape.
 *
 * Data comes from `lib/data.ts`, which serves docs/reference/demo.json as a
 * static fixture. A3 swaps that for the API and nothing here changes, because
 * the fixture and the API response are the same shape (ADR-020).
 */
import { fmt, fundMetrics, isEvergreen } from '@portfolio-command/metrics';

import { AppShell, NotYetPorted, TABS, useApp, type TabId } from '../components/AppShell';
import { CompanyDrawer } from '../components/drawers/CompanyDrawer';
import { DashboardTab } from '../components/tabs/DashboardTab';
import { asOfDate, loadPortfolio } from '../lib/data';

const db = loadPortfolio();
const asOf = asOfDate(db);

function DrawerContent() {
  const { drawer } = useApp();
  if (!drawer) return null;

  if (drawer.kind === 'company') {
    const company = db.companies.find((c) => c.id === drawer.id);
    return company ? <CompanyDrawer company={company} /> : null;
  }
  return null;
}

function FundTag() {
  const m = fundMetrics(db, { asOf });
  return (
    <>
      <b>{db.fund.name}</b>
      {isEvergreen(db) && <span style={{ color: '#7fb0ff' }}> EVERGREEN</span>}
      <br />
      NAV {fmt.m(m.fmv)} - TVPI {fmt.x(m.tvpi)} - {m.nActive} companies
    </>
  );
}

export default function Home() {
  return (
    <AppShell fundTag={<FundTag />} drawerContent={<DrawerContent />}>
      {(tab: TabId) => {
        if (tab === 'dashboard') return <DashboardTab db={db} asOf={asOf} />;
        return <NotYetPorted tab={TABS.find((t) => t.id === tab)?.label ?? tab} />;
      }}
    </AppShell>
  );
}
