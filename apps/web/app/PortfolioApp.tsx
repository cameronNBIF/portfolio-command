'use client';

/**
 * The application. Eight tabs, ported one-to-one from the prototype (ADR-014),
 * rendering from the ADR-001 contract shape.
 *
 * A2 built this against `docs/reference/demo.json` served as a static fixture.
 * A3 replaced the source with Postgres and, as ADR-020 predicted, the swap cost
 * this file its two module-level constants and nothing else -- the fixture and
 * the API response are the same shape, so every component below still receives
 * exactly what it received before.
 *
 * `db` and `asOf` now arrive as props from the server component in `page.tsx`,
 * which reads them through `packages/api`.
 */
import type { KpiCoverageRow } from '@portfolio-command/api';
import type { PortfolioExport } from '@portfolio-command/contract';
import { fmt, fundMetrics, isEvergreen } from '@portfolio-command/metrics';

import { AppShell, NotYetPorted, TABS, useApp, type TabId } from '../components/AppShell';
import { CompanyDrawer } from '../components/drawers/CompanyDrawer';
import { DealDrawer } from '../components/drawers/DealDrawer';
import { FinancialHistoryDrawer } from '../components/drawers/FinancialHistoryDrawer';
import { FundInvestmentDrawer } from '../components/drawers/FundInvestmentDrawer';
import { DashboardTab } from '../components/tabs/DashboardTab';
import { DataTab } from '../components/tabs/DataTab';
import { FinanceTab } from '../components/tabs/FinanceTab';
import { FundsTab } from '../components/tabs/FundsTab';
import { PipelineTab } from '../components/tabs/PipelineTab';
import { MemoTab } from '../components/tabs/MemoTab';
import { ModelingTab } from '../components/tabs/ModelingTab';
import { PortfolioTab } from '../components/tabs/PortfolioTab';
import { ReportsTab } from '../components/tabs/ReportsTab';
import { EditableProvider, useEditable } from '../lib/editable';

/**
 * What every component below needs. Previously two module-level constants read
 * off the fixture at import time; now props, because the document is per-request
 * and module state on a server is shared across every request in flight.
 */
interface PortfolioProps {
  db: PortfolioExport;
  asOf: string;
}

function DrawerContent({ db, asOf }: PortfolioProps) {
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
  if (drawer.kind === 'financial-history') {
    return <FinancialHistoryDrawer table={drawer.table} id={drawer.id} />;
  }
  return null;
}

function FundTag({ db, asOf }: PortfolioProps) {
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

function Tab({ tab, db, asOf, kpiCoverage }: PortfolioProps & { tab: TabId; kpiCoverage: KpiCoverageRow[] }) {
  switch (tab) {
    case 'dashboard':
      return <DashboardTab db={db} asOf={asOf} />;
    case 'portfolio':
      return <PortfolioTab db={db} />;
    case 'funds':
      return <FundsTab db={db} asOf={asOf} />;
    case 'pipeline':
      return <PipelineTab db={db} asOf={asOf} />;
    case 'modeling':
      return <ModelingTab db={db} asOf={asOf} />;
    case 'memo':
      return <MemoTab db={db} asOf={asOf} />;
    case 'reports':
      return <ReportsTab db={db} asOf={asOf} />;
    case 'data':
      return <DataTab db={db} asOf={asOf} kpiCoverage={kpiCoverage} />;
    case 'finance':
      // Role-gated in the nav; the API enforces it again on every write, so a
      // hand-constructed request gains nothing.
      return <FinanceTab db={db} />;
    default:
      return <NotYetPorted tab={TABS.find((t) => t.id === tab)?.label ?? tab} />;
  }
}

export function PortfolioApp({
  db,
  asOf,
  kpiCoverage,
  role,
}: PortfolioProps & { kpiCoverage: KpiCoverageRow[]; role: string }) {
  return (
    <EditableProvider db={db}>
      <AppShell
        role={role}
        fundTag={<FundTag db={db} asOf={asOf} />}
        drawerContent={<DrawerContent db={db} asOf={asOf} />}
        // ADR-020: driven by v_synthetic_data_status through the contract's
        // meta.demo, so the banner reflects what the database actually holds
        // rather than a build-time flag someone can forget to flip.
        containsSynthetic={db.meta.demo}
      >
        {(tab: TabId) => <Tab tab={tab} db={db} asOf={asOf} kpiCoverage={kpiCoverage} />}
      </AppShell>
    </EditableProvider>
  );
}
