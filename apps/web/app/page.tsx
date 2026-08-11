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
import { DealDrawer } from '../components/drawers/DealDrawer';
import { FundInvestmentDrawer } from '../components/drawers/FundInvestmentDrawer';
import { DashboardTab } from '../components/tabs/DashboardTab';
import { FundsTab } from '../components/tabs/FundsTab';
import { PipelineTab } from '../components/tabs/PipelineTab';
import { PortfolioTab } from '../components/tabs/PortfolioTab';
import { asOfDate, loadPortfolio } from '../lib/data';
import { EditableProvider, useEditable } from '../lib/editable';

const db = loadPortfolio();
const asOf = asOfDate(db);

function DrawerContent() {
  const { drawer } = useApp();
  const { pipeline } = useEditable();
  if (!drawer) return null;

  if (drawer.kind === 'company') {
    const company = db.companies.find((c) => c.id === drawer.id);
    return company ? <CompanyDrawer company={company} /> : null;
  }
  if (drawer.kind === 'lp') {
    const position = db.fundInvestments.find((f) => f.id === drawer.id);
    return position ? <FundInvestmentDrawer position={position} asOf={asOf} /> : null;
  }
  if (drawer.kind === 'deal') {
    // Read from the editable copy so a gate change is reflected immediately.
    const deal = pipeline.find((d) => d.id === drawer.id);
    return deal ? <DealDrawer deal={deal} /> : null;
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

function Tab({ tab }: { tab: TabId }) {
  switch (tab) {
    case 'dashboard':
      return <DashboardTab db={db} asOf={asOf} />;
    case 'portfolio':
      return <PortfolioTab db={db} />;
    case 'funds':
      return <FundsTab db={db} asOf={asOf} />;
    case 'pipeline':
      return <PipelineTab db={db} asOf={asOf} />;
    default:
      return <NotYetPorted tab={TABS.find((t) => t.id === tab)?.label ?? tab} />;
  }
}

export default function Home() {
  return (
    <EditableProvider db={db}>
      <AppShell fundTag={<FundTag />} drawerContent={<DrawerContent />}>
        {(tab: TabId) => <Tab tab={tab} />}
      </AppShell>
    </EditableProvider>
  );
}
