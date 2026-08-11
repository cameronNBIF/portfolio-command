/**
 * Shared presentational primitives.
 *
 * Each of these is a direct translation of a markup pattern the prototype
 * repeats inline. The class names are the prototype's and are defined in
 * globals.css -- these components exist so the markup is written once, not so
 * the styling can evolve. ADR-014: no visual change in phase 1.
 *
 * The prototype escaped every interpolated string through `esc()` because it
 * rendered via innerHTML. React escapes by default, so `esc()` does not port;
 * any `dangerouslySetInnerHTML` needs justification and there is none here.
 */
import type { ReactNode } from 'react';

export type Health = 'green' | 'yellow' | 'red' | string;
export type PillTone = 'green' | 'yellow' | 'red' | 'gray' | 'blue' | 'purple' | 'teal';

export function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

/** The health indicator. `.dot` carries its own colour and right margin. */
export function Dot({ tone }: { tone: Health }) {
  return <span className={`dot ${tone}`} />;
}

export function Card({
  title,
  headerExtra,
  children,
  bodyClassName,
  style,
  noBody,
}: {
  title?: ReactNode;
  headerExtra?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
  style?: React.CSSProperties;
  /** Tables sit directly in the card with no `.cbody` padding, as in the prototype. */
  noBody?: boolean;
}) {
  return (
    <div className="card" style={style}>
      {title !== undefined && (
        <div className="chead">
          <span>{title}</span>
          {headerExtra}
        </div>
      )}
      {noBody ? children : <div className={bodyClassName ?? 'cbody'}>{children}</div>}
    </div>
  );
}

/** A KPI tile: uppercase label, large value, small sub-line. */
export function Kpi({ label, value, sub, valueClass }: { label: ReactNode; value: ReactNode; sub?: ReactNode; valueClass?: string }) {
  return (
    <div className="kpi">
      <div className="k">{label}</div>
      <div className={valueClass ? `v ${valueClass}` : 'v'}>{value}</div>
      {sub !== undefined && <div className="s">{sub}</div>}
    </div>
  );
}

export function KpiRow({ children }: { children: ReactNode }) {
  return <div className="kpirow">{children}</div>;
}

/** A label/value pair inside a drawer section. */
export function Kv({ label, value, valueClass }: { label: ReactNode; value: ReactNode; valueClass?: string }) {
  return (
    <div className="item">
      <div className="l">{label}</div>
      <div className={valueClass ? `d ${valueClass}` : 'd'}>{value}</div>
    </div>
  );
}

export function KvGrid({ children }: { children: ReactNode }) {
  return <div className="kv">{children}</div>;
}

export function DrawerSection({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <div className="dsec">
      {title !== undefined && <h4>{title}</h4>}
      {children}
    </div>
  );
}

export function ViewHeader({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <>
      <h2 className="vtitle">{title}</h2>
      {sub !== undefined && <div className="vsub">{sub}</div>}
    </>
  );
}

export function AlertRow({ children }: { children: ReactNode }) {
  return <div className="alertrow">{children}</div>;
}

export function Progress({ pct }: { pct: number }) {
  return (
    <div className="progress">
      <div style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

/**
 * Colour class for a multiple: green at 1.5x and above, red below 1x, muted
 * between and for null (vc-toolkit.html :671).
 */
export function moicClass(m: number | null): string {
  return m == null ? 'flat' : m >= 1.5 ? 'up' : m < 1 ? 'down' : 'flat';
}

/** The `.hint` note a view uses to state its quarter convention (D-6). */
export function ConventionNote({ children }: { children: ReactNode }) {
  return (
    <div className="hint" style={{ marginTop: 6 }}>
      {children}
    </div>
  );
}
