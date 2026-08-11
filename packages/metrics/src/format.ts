/**
 * Display formatters, ported verbatim from the prototype's `fmt` object
 * (vc-toolkit.html :577-583) under ADR-013.
 *
 * These are part of the frozen surface, not a presentation detail. The
 * golden-master fixtures assert these strings EXACTLY, because a change that
 * moves 2.0787898936170217 without moving "2.08x" is invisible to the board
 * and a change from "$1.09B" to "$1092.1M" is visible to the board while
 * leaving the float untouched (ADR-022).
 *
 * The guard inconsistency between them is inherited, not accidental on our
 * part: only `x` checks isFinite. See INHERITED-COERCIONS.md §5.
 */

/** Locale for grouped integers. Pinned -- see `count()`. */
export const DISPLAY_LOCALE = 'en-CA';

export const fmt = {
  /**
   * Money, $M, switching to $B at an absolute value of 1000.
   * INHERITED: no isFinite guard, so Infinity renders "$InfinityB"; and a
   * negative renders "$-5.0M", with the sign inside the currency symbol.
   */
  m(v: number | null | undefined): string {
    if (v == null || Number.isNaN(v)) return '-';
    return `$${Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(2)}B` : `${v.toFixed(1)}M`}`;
  },

  /** A multiple. The only formatter that guards isFinite. Note fmt.x(0) is "0.00x", not "-". */
  x(v: number | null | undefined): string {
    if (v == null || Number.isNaN(v) || !Number.isFinite(v)) return '-';
    return `${v.toFixed(2)}x`;
  },

  /** A percentage, one decimal. INHERITED: no isFinite guard. */
  pct(v: number | null | undefined): string {
    if (v == null || Number.isNaN(v)) return '-';
    return `${v.toFixed(1)}%`;
  },

  /** A percentage, rounded to whole. INHERITED: no isFinite guard. */
  pct0(v: number | null | undefined): string {
    if (v == null || Number.isNaN(v)) return '-';
    return `${Math.round(v)}%`;
  },

  /** A date or any string. INHERITED: tests truthiness, so "" renders "-". */
  d(s: string | null | undefined): string {
    return s ? s : '-';
  },
};

/**
 * Grouped integer, as the dashboard renders job counts (:703, :1258).
 *
 * The prototype calls `Number.toLocaleString()` with no locale, making the
 * output depend on the environment. The locale is pinned here so the same
 * number renders the same string on a developer's machine and in CI --
 * otherwise a CI failure would report a metric change when the truth is a
 * locale difference. See INHERITED-COERCIONS.md §12.
 */
export function count(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '-';
  return v.toLocaleString(DISPLAY_LOCALE);
}

/** Leverage, as the dashboard renders it (:700): "2.6 : 1". */
export function ratio(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '-';
  return `${v.toFixed(1)} : 1`;
}

/** A growth percentage with an explicit sign, as the dashboard renders it (:699, :702). */
export function signedPct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '-';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}
