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

export type TabId = 'dashboard' | 'portfolio' | 'funds' | 'pipeline' | 'modeling' | 'memo' | 'reports' | 'data';

/** Label and order exactly as the prototype's `#mainnav` (:163-172). */
export const TABS: { id: TabId; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'portfolio', label: 'Portfolio' },
  { id: 'funds', label: 'Funds' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'modeling', label: 'Modeling' },
  { id: 'memo', label: 'Memo Builder' },
  { id: 'reports', label: 'Reports' },
  { id: 'data', label: 'Data' },
];

/** What the drawer is currently showing. Null means closed. */
export type DrawerTarget =
  | { kind: 'company'; id: string }
  | { kind: 'deal'; id: string }
  | { kind: 'lp'; id: string }
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
  children,
}: {
  /** The header's right-hand summary line. */
  fundTag: ReactNode;
  /** Rendered inside `#drawer` when a target is set. */
  drawerContent: ReactNode;
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

  const value = useMemo<AppState>(
    () => ({ tab, setTab, drawer, openDrawer, closeDrawer, openCompany, memoTarget, setMemoTarget, openMemoFor, toast }),
    [tab, drawer, openDrawer, closeDrawer, openCompany, memoTarget, openMemoFor, toast],
  );

  return (
    <AppContext.Provider value={value}>
      <div id="app">
        <header>
          <div className="logo">
            PORTFOLIO<span>COMMAND</span>
          </div>
          <nav id="mainnav">
            {TABS.map((t) => (
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
