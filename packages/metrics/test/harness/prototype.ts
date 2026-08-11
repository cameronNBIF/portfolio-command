/**
 * Loads the v1 prototype under Node so its metric functions can be executed
 * directly. ADR-022: the script is extracted from the committed HTML at load
 * time and NEVER vendored. There is no copy of the prototype's JavaScript in
 * this repository -- `docs/reference/vc-toolkit.html` is the only one, and it
 * is the thing under test.
 *
 * This mirrors packages/db/test/migration-parity.test.ts, which reads
 * docs/schema.sql directly for the same reason: a stale duplicate of a
 * reference document is the exact failure mode being designed out.
 *
 * This file performs I/O. That is deliberate and confined to test tooling --
 * packages/metrics/src stays pure (CLAUDE.md, ADR-003).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../../..');
export const PROTOTYPE_PATH = path.join(REPO_ROOT, 'docs/reference/vc-toolkit.html');
export const DEMO_PATH = path.join(REPO_ROOT, 'docs/reference/demo.json');

/**
 * The date the prototype's `new Date()` calls resolve to inside the harness.
 *
 * fundMetrics, fiMetrics and fiIrr each date their terminal NAV cashflow with
 * `new Date()`. That is an undeclared input: two consecutive calls on
 * identical data return different numbers, and the figure drifts roughly a
 * percentage point per quarter. Pinning it is what makes an IRR fixture
 * possible at all (ADR-021, ADR-022).
 *
 * 2026-03-31 is the effective date of every valuation mark in demo.json and
 * the end of its last navHistory quarter. Any other date makes the terminal
 * NAV inconsistent with the marks behind it.
 */
export const AS_OF = '2026-03-31';

/**
 * Locale for the grouped job counts the dashboard renders through
 * `Number.toLocaleString()` (vc-toolkit.html :703, :1258).
 *
 * The prototype passes no locale, so in a browser it follows the reader's
 * machine and there is no single "correct" string to freeze. Pinning it here
 * makes the capture reproducible on a Windows laptop and a Linux runner alike.
 *
 * Deliberately duplicated from `src/format.ts` rather than imported: the
 * harness must not depend on the implementation it exists to check (ADR-022).
 * `golden-master.test.ts` asserts the two agree, so the duplication cannot rot.
 */
export const DISPLAY_LOCALE = 'en-CA';

/** The shape the epilogue exports out of the prototype's lexical scope. */
export interface PrototypeApi {
  DB: PrototypeDb;
  fmt: {
    m(v: number | null): string;
    x(v: number | null): string;
    pct(v: number | null): string;
    pct0(v: number | null): string;
    d(s: string | null): string;
  };
  moic(c: PrototypeCompany): number | null;
  activeCompanies(): PrototypeCompany[];
  isEvergreen(): boolean;
  fundMetrics(): Record<string, number | null>;
  xirr(flows: { date: Date; amt: number }[]): number | null;
  healthAlerts(): { c: PrototypeCompany; sev: string; text: string }[];
  fiTvpi(f: PrototypeFundInvestment): number | null;
  fiDpi(f: PrototypeFundInvestment): number | null;
  fiIrr(f: PrototypeFundInvestment): number | null;
  fiMetrics(): Record<string, number | null>;
  suggestedReserve(c: PrototypeCompany): number;
  scenarioDefaults(c: PrototypeCompany): Record<string, number | boolean | null>;
  runScenario(c: PrototypeCompany, s: Record<string, unknown>): PrototypeScenario;
}

/* The prototype is untyped JavaScript. These are the shapes the harness
   touches, not a contract -- packages/contract owns that (ADR-021). */
export interface PrototypeCompany {
  id: string;
  name: string;
  exited?: boolean;
  invested: number;
  fmv: number;
  realized: number;
  ownershipPct: number;
  health: string;
  proRata?: boolean;
  rounds: { date: string; invested: number; roundTotal?: number; nbOther?: number }[];
  kpis: { period: string; revenue: number }[];
  [k: string]: unknown;
}
export interface PrototypeFundInvestment {
  id: string;
  called: number;
  nav: number;
  distributions: number;
  cashflows?: { date: string; amount: number }[];
  [k: string]: unknown;
}
export interface PrototypeScenario {
  post: number;
  ownAfter: number;
  investedTotal: number;
  ourPref: number;
  totalPref: number;
  proceedsAt(e: number): number;
  cases: [string, { E: number; p: number; mo: number; irr: number | null }][];
  [k: string]: unknown;
}
export interface PrototypeDb {
  fund: Record<string, unknown>;
  companies: PrototypeCompany[];
  pipeline: unknown[];
  fundInvestments: PrototypeFundInvestment[];
  memos: Record<string, unknown>;
  meta: Record<string, unknown>;
}

export interface LoadedPrototype {
  api: PrototypeApi;
  /** The DB the prototype booted with -- freshDB() via loadDB(). */
  bootDb: PrototypeDb;
  prototypeSha256: string;
  scriptBytes: number;
}

/**
 * Line endings are normalised before hashing so a digest describes CONTENT,
 * not a checkout. Development happens on Windows (CRLF working copy) while CI
 * runs on Linux (LF); without this the same committed file hashes two
 * different ways and the capture stops being reproducible across platforms.
 * `migration-parity.test.ts` normalises for the same reason.
 *
 * Nothing downstream of this is affected by line endings -- demo.json parses
 * identically either way, and the prototype's behaviour under `vm` does not
 * depend on them -- so this only touches the recorded provenance.
 */
const normaliseEol = (s: string) => s.replace(/\r\n/g, '\n');
const sha256 = (s: string) => createHash('sha256').update(normaliseEol(s), 'utf8').digest('hex');

/**
 * A Date whose zero-argument constructor is pinned to AS_OF. Every other form
 * -- new Date("2021-03-15"), new Date(ms) -- behaves normally, because the
 * prototype parses round and cashflow dates through the same constructor.
 */
function pinnedDate(iso: string): DateConstructor {
  const Real = Date;
  const fixed = new Real(`${iso}T00:00:00.000Z`).getTime();
  class Pinned extends Real {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixed);
      // @ts-expect-error -- forwarding a variadic Date constructor
      else super(...args);
    }
    static override now(): number {
      return fixed;
    }
  }
  return Pinned as unknown as DateConstructor;
}

/** Minimal DOM/Chart/localStorage stubs. The prototype renders at boot. */
function makeStubs() {
  const noop = () => undefined;
  const element: unknown = new Proxy(
    {},
    {
      get(_t, key) {
        if (key === 'classList') return { add: noop, remove: noop, toggle: noop, contains: () => false };
        if (key === 'dataset') return {};
        if (key === 'style') return {};
        if (key === 'files') return [];
        if (key === 'textContent' || key === 'innerHTML' || key === 'value') return '';
        if (key === Symbol.toPrimitive) return () => '';
        return noop;
      },
      set: () => true,
    },
  );
  return {
    document: {
      querySelector: () => element,
      querySelectorAll: () => [],
      getElementById: () => element,
      createElement: () => element,
      addEventListener: noop,
      documentElement: element,
    },
    Chart: class {
      destroy() {}
      static defaults: Record<string, unknown> = { font: {}, color: '' };
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: noop,
    window: { print: noop },
    navigator: { clipboard: { writeText: async () => undefined } },
    URL: { createObjectURL: () => '', revokeObjectURL: noop },
    Blob: class {},
    alert: noop,
    confirm: () => false,
  };
}

/**
 * Top-level `let`/`const` in a vm script -- DB, fmt, PF, MODEL -- do NOT become
 * properties of the context object. Only `function` and `var` declarations do.
 * This epilogue is evaluated inside the prototype's own lexical scope, which is
 * the only way to reach those bindings. It is the sole text ever appended to
 * the prototype's source (ADR-022).
 */
const EPILOGUE = `
;globalThis.__protoApi = {
  get DB(){ return DB; }, set DB(v){ DB = v; },
  fmt: fmt,
  moic: moic, activeCompanies: activeCompanies, isEvergreen: isEvergreen,
  fundMetrics: fundMetrics, xirr: xirr, healthAlerts: healthAlerts,
  fiTvpi: fiTvpi, fiDpi: fiDpi, fiIrr: fiIrr, fiMetrics: fiMetrics,
  suggestedReserve: suggestedReserve,
  scenarioDefaults: scenarioDefaults, runScenario: runScenario
};`;

/**
 * Extract the single inline <script> from the prototype and evaluate it.
 *
 * Must be called at most ONCE per process. The demo generator's
 * `mulberry32(42)` is a module-level singleton whose stream is consumed at boot
 * by loadDB(); a second load in the same context, or any later call to
 * freshDB(), yields different companies (ADR-022).
 */
export function loadPrototype(): LoadedPrototype {
  const html = readFileSync(PROTOTYPE_PATH, 'utf8');

  const tags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  const inline = tags.filter((t) => !/\bsrc=/.test(t[1] ?? ''));
  if (inline.length !== 1) {
    throw new Error(
      `Expected exactly one inline <script> in ${PROTOTYPE_PATH}, found ${inline.length}. ` +
        `The harness extracts the prototype's script rather than vendoring it (ADR-022); ` +
        `if the file has been restructured the extraction must be revisited, not widened.`,
    );
  }
  const source = inline[0]![2]!;

  const context: Record<string, unknown> = {
    ...makeStubs(),
    Date: pinnedDate(AS_OF),
    console,
    setTimeout,
    clearTimeout,
  };
  context.globalThis = context;
  vm.createContext(context);

  try {
    vm.runInContext(source + EPILOGUE, context, { filename: 'vc-toolkit.inline.js' });
  } catch (cause) {
    throw new Error(
      'The prototype threw while loading under Node. No fixtures were written. ' +
        'A partial capture is worse than none (ADR-022).',
      { cause },
    );
  }

  const api = context.__protoApi as PrototypeApi | undefined;
  if (!api) throw new Error('Prototype loaded but the export epilogue did not run.');

  return {
    api,
    bootDb: api.DB,
    prototypeSha256: sha256(html),
    scriptBytes: normaliseEol(source).length,
  };
}

/** The committed golden-master input, with its digest. */
export function loadDemoJson(): { demo: PrototypeDb; sha256: string; raw: string } {
  const raw = readFileSync(DEMO_PATH, 'utf8');
  return { demo: JSON.parse(raw) as PrototypeDb, sha256: sha256(raw), raw };
}

/**
 * demo.json must still be byte-identical to the prototype's boot state.
 *
 * It is not an arbitrary sample: it is `freshDB()` serialised. Asserting the
 * identity turns an accidental drift -- someone re-exports, someone edits the
 * HTML -- into a loud failure at capture time rather than a silent one where
 * every fixture quietly describes a dataset nobody has (ADR-022).
 */
export function assertDemoMatchesBoot(bootDb: PrototypeDb, demo: PrototypeDb): void {
  if (JSON.stringify(bootDb) !== JSON.stringify(demo)) {
    throw new Error(
      'docs/reference/demo.json is no longer identical to the prototype boot state.\n' +
        'Either vc-toolkit.html changed, or demo.json was re-exported. Both invalidate\n' +
        'every fixture at once (ADR-022). Resolve deliberately: recapture the fixtures\n' +
        'and record the change in BUILD-LOG.md. No fixtures were written.',
    );
  }
}
