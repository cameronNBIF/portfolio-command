'use client';

/**
 * The application shell: header, tab nav, scrolling main, detail drawer,
 * overlay and toast.
 *
 * Structure ports one-to-one from the prototype's `<body>` (vc-toolkit.html
 * :159-189) and its `switchView` / `openCompany` / `closeDrawer` behaviour.
 * The prototype swapped `innerHTML` into a single `#drawer` element; React
 * mounts the drawer's content instead, but the markup, classes and the .22s
 * slide transition are unchanged (ADR-014).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type TabId =
  | 'dashboard' | 'portfolio' | 'funds' | 'pipeline'
  | 'modeling' | 'memo' | 'reports' | 'data' | 'finance' | 'dealclose' | 'alerts' | 'policies'
  | 'exited' | 'reconciliation';

/**
 * The nav, in the order Cameron set on 21 August 2026.
 *
 * THE PORTED EIGHT KEEP THEIR RELATIVE ORDER AND ARE NO LONGER CONTIGUOUS, and
 * that is the change worth being explicit about. The prototype's `#mainnav`
 * (:163-172) runs Dashboard, Portfolio, Funds, Pipeline, Modeling, Memo
 * Builder, Reports, Data, and every one of those still follows the one before
 * it. What is new is that the additions are interleaved rather than appended:
 * Exited sits with Portfolio and Funds because it answers a question about the
 * portfolio, and Data moves to the end because it is the developer's view of
 * the export contract rather than a place anyone works.
 *
 * ADR-014 IS NOT BREACHED, and the reason is worth stating rather than
 * assuming. That ADR freezes the PORT: layout, terminology, colour conventions,
 * drawer behaviour and the eight tabs' own content. It is about what each
 * screen shows and how it behaves, not about which order a nav bar that has
 * grown from eight items to fourteen puts them in. Grouping by what a person
 * is doing — looking at the portfolio, modelling, reporting, entering data,
 * checking the platform's own records — is what keeps fourteen items usable.
 * The eight screens themselves are untouched.
 *
 * THE ENTRY TABS ARE ADDITIONS TO THE PROTOTYPE'S EIGHT. The prototype has no
 * data entry anywhere — every figure in it is a literal in a JavaScript object
 * — so A7's and A8's entry interfaces cannot be a port of anything and have to
 * be new surface. Keeping them off the eight is what protects the parity
 * criterion; where they sit in the bar is a separate question.
 *
 * DEAL CLOSE AND FINANCE ARE SEPARATE BECAUSE THEIR AUTHORS ARE. Finance
 * records what we paid; Deal Close records the round we paid into. ADR-005
 * splits those by source of record and ADR-012 assigns the second to the deal
 * lead, so one tab over both would mean one role gate over both, and the wider
 * of the two would win.
 *
 * `roles` gates visibility. Absent means everyone.
 */
export const TABS: { id: TabId; label: string; roles?: readonly string[] }[] = [
  // --- the portfolio, as it stands -------------------------------------------
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'portfolio', label: 'Portfolio' },
  { id: 'funds', label: 'Funds' },
  { id: 'pipeline', label: 'Pipeline' },
  // F4, FR-29. Complements the Portfolio tab rather than changing it: that tab
  // keeps the prototype's own active / include exited / exited only control
  // (ADR-014), and this is the exit as an EVENT, which the prototype has no
  // concept of. Sits beside Portfolio and Funds because that is the question it
  // answers -- who is in the portfolio and who has left.
  //
  // No role gate. Who left the portfolio and when is a board figure; the entry
  // form inside is gated to finance and admin, and the API re-checks it.
  { id: 'exited', label: 'Exited' },

  // --- working the portfolio -------------------------------------------------
  { id: 'modeling', label: 'Modeling' },
  { id: 'memo', label: 'Memo Builder' },
  { id: 'reports', label: 'Reports' },
  // A9. Matches CAN_EDIT_JUDGEMENT: the people who own the judgement records
  // this tab configures are the ones who see it. Leadership reads the board
  // feed on the Dashboard, which is unchanged and needs no gate.
  { id: 'alerts', label: 'Alerts', roles: ['vc', 'admin'] },
  // F3. The UNION of the two sections it holds: alert policies for the
  // investment team, finance policies for Finance, each gated again inside the
  // tab. A tab visible to nobody but `admin` would have made the split
  // pointless, and one visible to everybody would offer leadership two cards
  // they cannot use.
  { id: 'policies', label: 'Policies', roles: ['vc', 'finance', 'admin'] },

  // --- putting data in, and checking what went in ----------------------------
  // Matches CAN_CAPTURE_ROUND (ADR-012). Sits before Finance because a round is
  // captured at close, which is upstream of the cheque being booked.
  { id: 'dealclose', label: 'Deal Close', roles: ['vc', 'finance', 'admin'] },
  // Matches CAN_WRITE_FINANCIAL. A tab that appears for the VC team and then
  // refuses every action would be worse than one that is not offered.
  { id: 'finance', label: 'Finance', roles: ['finance', 'admin'] },
  // F6, FR-09. No role gate, and that is the decision rather than an omission.
  // Half of these checks are the VC team's to fix -- an unlinked cheque, a round
  // with no cheque against it -- and half are Finance's. Putting the list behind
  // CAN_WRITE_FINANCIAL would hide the deal leads' own queue from them, which is
  // the same reason Exited became a tab rather than a Finance surface. Every fix
  // still happens behind its own gate, on the screen that owns the record.
  //
  // Immediately after the two entry tabs, because it reports on what they wrote.
  { id: 'reconciliation', label: 'Reconciliation' },

  // --- the raw contract ------------------------------------------------------
  // Last, and it is the one ported tab that moved. It renders the ADR-001
  // export document itself -- a developer's and an auditor's view of the
  // platform, not a place anyone in the VC or finance team works.
  { id: 'data', label: 'Data' },
];

/** What the drawer is currently showing. Null means closed. */
export type DrawerTarget =
  | { kind: 'company'; id: string }
  | { kind: 'deal'; id: string }
  | { kind: 'lp'; id: string }
  /** One financial row's change history (ADR-031). */
  | { kind: 'financial-history'; table: string; id: string }
  | null;

interface AppState {
  tab: TabId;
  setTab: (t: TabId) => void;
  drawer: DrawerTarget;
  openDrawer: (t: NonNullable<DrawerTarget>) => void;
  closeDrawer: () => void;
  /** Opens a company in the drawer. */
  openCompany: (id: string) => void;
  /** Which entity the Memo Builder is drafting against. */
  memoTarget: string | null;
  setMemoTarget: (id: string) => void;
  /** Closes the drawer, switches to the Memo Builder and targets an entity. */
  openMemoFor: (id: string) => void;
  toast: (message: string) => void;
  /**
   * The caller's role (ADR-005).
   *
   * Exposed on the context because the DRAWER needs it and the drawer is not a
   * tab — it opens over any of them, so it cannot inherit a gate from the
   * navigation the way Finance and Deal Close do. Every write it offers is
   * re-checked server-side regardless; this only decides whether an control
   * that would be refused is offered at all.
   */
  role: string;
}

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppShell>');
  return ctx;
}

export function AppShell({
  fundTag,
  drawerContent,
  containsSynthetic,
  role,
  children,
}: {
  /** The header's right-hand summary line. */
  fundTag: ReactNode;
  /** The caller's role, from `app_user` (ADR-005). Gates which tabs are shown. */
  role: string;
  /** Rendered inside `#drawer` when a target is set. */
  drawerContent: ReactNode;
  /**
   * `v_synthetic_data_status.contains_synthetic`, straight from the database.
   *
   * ADR-020, condition 3: while this is true a persistent banner appears on
   * every screen, and it is never suppressed. It disappears only when the
   * synthetic row count actually reads zero at cutover (A13) -- not when
   * someone decides the numbers look plausible enough to demo without it.
   */
  containsSynthetic: boolean;
  children: (tab: TabId) => ReactNode;
}) {
  const [tab, setTab] = useState<TabId>('dashboard');
  const [drawer, setDrawer] = useState<DrawerTarget>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [memoTarget, setMemoTarget] = useState<string | null>(null);

  const closeDrawer = useCallback(() => setDrawer(null), []);
  const openDrawer = useCallback((t: NonNullable<DrawerTarget>) => setDrawer(t), []);
  const openCompany = useCallback((id: string) => setDrawer({ kind: 'company', id }), []);

  // `startMemoFor` (:1166): close the drawer, switch tab, target the entity.
  const openMemoFor = useCallback((id: string) => {
    setMemoTarget(id);
    setDrawer(null);
    setTab('memo');
  }, []);

  const toast = useCallback((message: string) => {
    setToastMessage(message);
    // Matches the prototype's 2200ms dismissal (:669).
    const timer = setTimeout(() => setToastMessage(null), 2200);
    return () => clearTimeout(timer);
  }, []);

  // Escape closes the drawer, as in the prototype (:1708).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDrawer();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeDrawer]);

  // Lock body scroll behind the drawer. The prototype did not; nothing visible
  // moves, it just stops the page scrolling under an open panel.
  useEffect(() => {
    document.body.classList.toggle('drawer-open', drawer !== null);
    return () => document.body.classList.remove('drawer-open');
  }, [drawer]);

  const visibleTabs = useMemo(
    () => TABS.filter((t) => !t.roles || t.roles.includes(role)),
    [role],
  );

  const value = useMemo<AppState>(
    () => ({ tab, setTab, drawer, openDrawer, closeDrawer, openCompany, memoTarget, setMemoTarget, openMemoFor, toast, role }),
    [tab, drawer, openDrawer, closeDrawer, openCompany, memoTarget, openMemoFor, toast, role],
  );

  return (
    <AppContext.Provider value={value}>
      <div id="app">
        {containsSynthetic && (
          <div id="syntheticbanner" role="status">
            <b>SYNTHETIC DATA</b> — financial figures on this screen are generated for development
            and are not NBIF&rsquo;s real portfolio. Do not quote them.
          </div>
        )}
        <header>
          <div className="logo">
            PORTFOLIO<span>COMMAND</span>
          </div>
          <nav id="mainnav">
            {visibleTabs.map((t) => (
              <button key={t.id} className={t.id === tab ? 'active' : undefined} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <div className="spacer" />
          <div className="fundtag">{fundTag}</div>
        </header>
        <main>
          {/* The prototype kept all eight view divs mounted and toggled
              `.active`. React mounts only the active one, which is equivalent
              on screen and avoids eight tabs' worth of work per render. */}
          <div className="view active">{children(tab)}</div>
        </main>
      </div>

      <div id="overlay" className={drawer ? 'open' : undefined} onClick={closeDrawer} />
      <div id="drawer" className={drawer ? 'open' : undefined}>
        {drawer && drawerContent}
      </div>
      <div className={toastMessage ? 'toast show' : 'toast'}>{toastMessage}</div>
    </AppContext.Provider>
  );
}

/** The drawer's header bar: title block on the left, actions on the right. */
export function DrawerHeader({ children }: { children: ReactNode }) {
  const { closeDrawer } = useApp();
  return (
    <div className="dhead">
      <div style={{ flex: 1 }}>{children}</div>
      <button className="btn ghost sm" onClick={closeDrawer}>
        Close ✕
      </button>
    </div>
  );
}

export function DrawerBody({ children }: { children: ReactNode }) {
  return <div className="dbody">{children}</div>;
}

/** A view that has not been ported yet. Explicit rather than silently blank. */
export function NotYetPorted({ tab }: { tab: string }) {
  return (
    <>
      <h2 className="vtitle">{tab}</h2>
      <div className="vsub">Not yet ported.</div>
      <div className="card">
        <div className="cbody">
          <div className="small">
            This tab is part of the A2 frontend port and has not been built yet. It ports one-to-one from the
            prototype (ADR-014); until then, use <span className="mono">docs/reference/vc-toolkit.html</span>.
          </div>
        </div>
      </div>
    </>
  );
}
