/**
 * The request envelope: what the platform accepts as a write, and what it
 * refuses.
 *
 * THE FIRST TEST THIS LAYER HAS EVER HAD. The six parsers lived in
 * `apps/web/app/api/v1/*` until they moved beside their writers, and `apps/web`
 * has no test runner — so the code that turns untrusted JSON into a financial
 * mutation was asserted nowhere, in a repository that otherwise runs 550 tests.
 *
 * WHAT IS WORTH ASSERTING HERE, and what is not. Not the happy path in bulk:
 * that a well-formed body produces the mutation it looks like is covered by the
 * database-backed suites, which send bodies through and read rows back. What is
 * covered here is the set of rules the parsers exist to hold and that nothing
 * else can hold for them — the ones whose failure is silent, produces a
 * plausible-looking write, and would be found by a person reading a board figure
 * rather than by a test:
 *
 *   1. The three threshold states survive. Absent, `null` and `0` mean leave
 *      alone, inherit the fund policy, and disable the alert. Two of them
 *      collapse under a careless `??`.
 *   2. `null` survives where it is a value. On a round link it is the explicit
 *      "standalone" choice; on the influence threshold it is "no threshold in
 *      force", and `0` there would flag every company we hold a figure for.
 *   3. Absent is not the same as null. Omitting `investmentRoundId` is a caller
 *      who has not decided, and guessing is how a cheque gets silently detached.
 *   4. The allow-lists are closed. A judgement edit cannot name a financial
 *      table; a financial mutation cannot name a judgement record.
 *   5. Every parser refuses a body that is not an object, including `null` —
 *      which is what a malformed JSON payload arrives as, and the reason
 *      unparseable input is a 400 rather than a 500.
 *
 * NO DATABASE. These are pure functions over `unknown`, so this file runs in the
 * fast CI job beside the golden masters rather than in the services job.
 */
import { describe, expect, test } from 'vitest';

import { ValidationError } from '../src/write/errors.js';
import { parseExitMutation } from '../src/write/exits.js';
import { parseFinancePolicyEdit } from '../src/write/finance-policy.js';
import { parseFinancialMutation } from '../src/write/financial.js';
import { parseJudgementEdit } from '../src/write/judgement.js';
import { parseLinkTransactions } from '../src/write/link-transactions.js';
import { parseOwnershipMutation } from '../src/write/ownership.js';
import { parseRoundMutation } from '../src/write/rounds.js';

/** Every parser, so the shared rules can be stated once over all seven. */
const PARSERS: [string, (body: unknown) => unknown][] = [
  ['financial', parseFinancialMutation],
  ['round', parseRoundMutation],
  ['link-transactions', parseLinkTransactions],
  ['judgement', parseJudgementEdit],
  ['ownership', parseOwnershipMutation],
  ['exit', parseExitMutation],
  ['finance-policy', parseFinancePolicyEdit],
];

// ---------------------------------------------------------------------------
// The rules every parser shares
// ---------------------------------------------------------------------------

describe('every request parser', () => {
  /**
   * `null` IS THE SHAPE A MALFORMED PAYLOAD ARRIVES AS.
   *
   * `jsonBody()` catches the JSON parse failure and hands the parser `null`
   * rather than letting a SyntaxError escape to a 500. This is the assertion
   * that makes that safe: unparseable input and a non-object body come back as
   * the same client error. Three endpoints returned 500 here before `jsonBody`
   * existed.
   */
  test.each(PARSERS)('%s refuses a body that is not an object', (_name, parse) => {
    for (const body of [null, undefined, 'a string', 42, true, []]) {
      expect(() => parse(body)).toThrow(ValidationError);
    }
    expect(() => parse(null)).toThrow(/Body must be an object/);
  });

  test.each(PARSERS)('%s raises ValidationError, which handler.ts maps to 400', (_name, parse) => {
    try {
      parse({});
      throw new Error('expected a rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      // handler.ts matches by `name`, not by instance, so the route layer never
      // imports from the API package's internals. If this drifts, every
      // rejection on every endpoint silently becomes a 500.
      expect((err as Error).name).toBe('ValidationError');
    }
  });
});

// ---------------------------------------------------------------------------
// Financial mutations
// ---------------------------------------------------------------------------

describe('parseFinancialMutation', () => {
  const create = { table: 'transaction', op: 'create', values: { amount: '1000.00' } };

  test('carries the envelope through untouched', () => {
    const m = parseFinancialMutation({ ...create, reason: 'late grant', changeKind: 'new-information' });
    expect(m).toMatchObject({ table: 'transaction', op: 'create', reason: 'late grant' });
    expect(m.changeKind).toBe('new-information');
  });

  test('a missing reason is null rather than absent', () => {
    expect(parseFinancialMutation(create).reason).toBeNull();
    expect(parseFinancialMutation({ ...create, reason: 42 }).reason).toBeNull();
  });

  /**
   * ADR-018, and the boundary ADR-031 left intact. The allow-list is what makes
   * a judgement record unreachable from the financial endpoint — not a
   * convention, and not a check somewhere further down.
   */
  test('refuses a table that is not a financial table, and says where to go', () => {
    for (const table of ['company', 'deal_gate', 'company_health', 'audit_log', '']) {
      expect(() => parseFinancialMutation({ ...create, table })).toThrow(ValidationError);
    }
    expect(() => parseFinancialMutation({ ...create, table: 'company' }))
      .toThrow(/\/api\/v1\/judgement/);
  });

  test('accepts exactly the five financial tables', () => {
    for (const table of [
      'transaction', 'valuation_mark', 'fund_investment_nav', 'fund_distribution', 'fund_commitment',
    ]) {
      expect(parseFinancialMutation({ ...create, table }).table).toBe(table);
    }
  });

  test('refuses an op outside create, update, delete, restore', () => {
    for (const op of ['void', 'reverse', 'upsert', 'DELETE', '']) {
      expect(() => parseFinancialMutation({ ...create, op })).toThrow(/"op" must be one of/);
    }
  });

  test('delete and restore need a row id, and update needs one too', () => {
    expect(() => parseFinancialMutation({ table: 'transaction', op: 'delete' }))
      .toThrow(/"id" is required/);
    expect(() => parseFinancialMutation({ table: 'transaction', op: 'delete', id: 42 }))
      .toThrow(/"id" is required/);
    expect(() => parseFinancialMutation({ table: 'transaction', op: 'delete', id: '4a' }))
      .toThrow(/"id" is required/);
    expect(() => parseFinancialMutation({ ...create, op: 'update' }))
      .toThrow(/required on an update/);

    const del = parseFinancialMutation({ table: 'transaction', op: 'delete', id: '42' });
    expect(del).toMatchObject({ op: 'delete', id: '42' });
  });

  test('create and update need a values object', () => {
    expect(() => parseFinancialMutation({ table: 'transaction', op: 'create' }))
      .toThrow(/"values" must be an object/);
    expect(() => parseFinancialMutation({ table: 'transaction', op: 'create', values: 'x' }))
      .toThrow(/"values" must be an object/);
  });

  /**
   * The envelope does not police fields, and that is the design rather than a
   * gap. `applyFinancialMutation` owns every field rule and raises the same
   * error type; a second validator here would be a second thing to keep in step,
   * and the copy that drifts is the one the user reads.
   */
  test('leaves field rules entirely to the write path', () => {
    const m = parseFinancialMutation({ table: 'transaction', op: 'create', values: { nonsense: true } });
    expect(m.op).toBe('create');
  });
});

// ---------------------------------------------------------------------------
// Round capture
// ---------------------------------------------------------------------------

describe('parseRoundMutation', () => {
  const values = { companyId: 'c1', roundDate: '2026-01-01', label: 'Series A' };

  test('defaults coinvestors to an empty list', () => {
    const m = parseRoundMutation({ op: 'create', values: { ...values } });
    expect((m as { values: { coinvestors: unknown[] } }).values.coinvestors).toEqual([]);
  });

  test('refuses a coinvestors value that is not a list', () => {
    expect(() => parseRoundMutation({ op: 'create', values: { ...values, coinvestors: 'none' } }))
      .toThrow(/must be a list/);
  });

  test('carries both FR-08 and FR-14 envelope fields', () => {
    const m = parseRoundMutation({
      op: 'create',
      values: { ...values },
      changeKind: 'correction',
      duplicateAckReason: 'second tranche of the same round',
    });
    expect(m.changeKind).toBe('correction');
    expect(m.duplicateAckReason).toBe('second tranche of the same round');
  });

  /**
   * The fifth verb this endpoint accepts is named in the failure but is not a
   * fifth entry in the list, because it takes a different payload behind a
   * different gate (ADR-033). The route branches on it before reaching here.
   */
  test('names link-transactions without offering it as a capture op', () => {
    const message = (() => {
      try { parseRoundMutation({ op: 'nonsense' }); } catch (e) { return (e as Error).message; }
      return '';
    })();
    expect(message).toMatch(/create, update, delete, restore/);
    expect(message).toMatch(/link-transactions/);
    expect(message).not.toMatch(/restore, link-transactions/);
  });
});

// ---------------------------------------------------------------------------
// The cheque-to-round link (ADR-033)
// ---------------------------------------------------------------------------

describe('parseLinkTransactions', () => {
  /**
   * NULL AND ABSENT ARE DIFFERENT AND MUST STAY DIFFERENT.
   *
   * `null` is the form's explicit *No round — standalone* choice and has to be
   * expressible, because a mutation whose no-op case is indistinguishable from
   * its clear case is one nobody can use to clear anything. A body that omits
   * the key is a caller who has not decided, and guessing which they meant is
   * how a cheque gets silently detached from its round.
   */
  test('accepts an explicit null round and rejects an absent one', () => {
    const standalone = parseLinkTransactions({ transactionIds: ['1'], investmentRoundId: null });
    expect(standalone.investmentRoundId).toBeNull();

    expect(() => parseLinkTransactions({ transactionIds: ['1'] }))
      .toThrow(/"investmentRoundId" is required/);
    expect(() => parseLinkTransactions({ transactionIds: ['1'], investmentRoundId: undefined }))
      .toThrow(/"investmentRoundId" is required/);
  });

  test('needs at least one transaction to move', () => {
    expect(() => parseLinkTransactions({ transactionIds: [], investmentRoundId: null }))
      .toThrow(/non-empty list/);
    expect(() => parseLinkTransactions({ transactionIds: '7', investmentRoundId: null }))
      .toThrow(/non-empty list/);
  });

  test('normalises ids to strings for the write path to shape-check', () => {
    const m = parseLinkTransactions({ transactionIds: [1, '2'], investmentRoundId: 9 });
    expect(m.transactionIds).toEqual(['1', '2']);
    expect(m.investmentRoundId).toBe('9');
  });
});

// ---------------------------------------------------------------------------
// Judgement edits (ADR-018, ADR-032)
// ---------------------------------------------------------------------------

describe('parseJudgementEdit', () => {
  /**
   * THE THREE THRESHOLD STATES, which is the rule this whole file exists for.
   *
   * Absent leaves the stored value alone. `null` clears it so the company
   * inherits the fund policy. `0` disables the alert outright. A parser that
   * folded `null` into `undefined` would make it impossible to hand a company
   * back to the policy once it had a number of its own — silently, on a
   * watchlist nobody would notice had stopped watching.
   */
  test('keeps absent, null and zero apart on a company threshold', () => {
    const edit = parseJudgementEdit({
      kind: 'company-threshold',
      companyId: 'c1',
      thresholds: { minRunwayMo: null, maxBurnMult: 0 },
    });
    const t = (edit as { thresholds: Record<string, unknown> }).thresholds;
    expect(t['minRunwayMo']).toBeNull();
    expect(t['maxBurnMult']).toBe(0);
    expect(t['minCashBalance']).toBeUndefined();
    expect('minCashBalance' in t).toBe(true);
  });

  test('refuses a negative or non-finite threshold, and says what null means', () => {
    const bad = (thresholds: unknown) =>
      () => parseJudgementEdit({ kind: 'company-threshold', companyId: 'c1', thresholds });
    expect(bad({ minRunwayMo: -1 })).toThrow(/non-negative/);
    expect(bad({ minRunwayMo: Number.NaN })).toThrow(/non-negative/);
    expect(bad({ minRunwayMo: '12' })).toThrow(/inherit the fund policy/);
  });

  /**
   * The fund policy is the other half of the same idea and takes the opposite
   * rule: every field is stated, so an omitted metric becomes an explicit null
   * rather than leaving the superseded row's value in force. "This is our
   * policy" has to mean all of it.
   */
  test('a fund alert policy states every field, absent becoming null', () => {
    const edit = parseJudgementEdit({ kind: 'alert-policy', minRunwayMo: 12 }) as Record<string, unknown>;
    expect(edit['minRunwayMo']).toBe(12);
    expect(edit['maxBurnMult']).toBeNull();
    expect(edit['minCashBalance']).toBeNull();
    expect(edit['maxRevenueDeclinePct']).toBeNull();
    expect(edit['minNrrPct']).toBeNull();
    expect(edit['note']).toBeNull();
  });

  /**
   * ADR-032. Health is not editable here and the refusal has to say why, because
   * the obvious next move for someone who hits it is to look for another
   * endpoint rather than to go and change it in Affinity.
   */
  test('refuses an unknown kind, naming where financial rows and health live', () => {
    const message = (() => {
      try { parseJudgementEdit({ kind: 'company-health', companyId: 'c1' }); }
      catch (e) { return (e as Error).message; }
      return '';
    })();
    expect(message).toMatch(/\/api\/v1\/financial/);
    expect(message).toMatch(/Affinity/);
    expect(message).not.toMatch(/company-health,/);
  });

  test('refuses a financial table dressed as a judgement edit', () => {
    for (const kind of ['transaction', 'valuation_mark', 'fund_commitment']) {
      expect(() => parseJudgementEdit({ kind })).toThrow(/"kind" must be one of/);
    }
  });

  test('a risk flag inherits severity when it is omitted or null', () => {
    const omitted = parseJudgementEdit({ kind: 'risk-flag-raise', companyId: 'c1', category: 'runway' });
    expect((omitted as { severity: unknown }).severity).toBeNull();
    expect((omitted as { note: unknown }).note).toBeNull();

    expect(() => parseJudgementEdit({
      kind: 'risk-flag-raise', companyId: 'c1', category: 'runway', severity: 'amber',
    })).toThrow(/"red", "yellow", or null/);
  });

  test('an acknowledgement needs the four fields that make it answerable', () => {
    for (const missing of ['companyId', 'alertKey', 'reason', 'untilDate']) {
      const body: Record<string, unknown> = {
        kind: 'alert-acknowledge',
        companyId: 'c1', alertKey: 'runway', reason: 'bridge signed', untilDate: '2026-12-31',
      };
      delete body[missing];
      expect(() => parseJudgementEdit(body)).toThrow(new RegExp(`"${missing}"`));
    }
  });

  test('an empty string is not a value for a required field', () => {
    expect(() => parseJudgementEdit({ kind: 'deal-gate', dealId: '', gateName: 'ic', status: 'pass' }))
      .toThrow(/"dealId" must be a non-empty string/);
  });
});

// ---------------------------------------------------------------------------
// Ownership (F3, ADR-035)
// ---------------------------------------------------------------------------

describe('parseOwnershipMutation', () => {
  test('set carries values, delete and restore carry a row id', () => {
    expect(parseOwnershipMutation({ op: 'set', values: { companyId: 'c1' } }).op).toBe('set');
    expect(parseOwnershipMutation({ op: 'delete', id: '7' })).toMatchObject({ op: 'delete', id: '7' });
    expect(() => parseOwnershipMutation({ op: 'delete' })).toThrow(/ownership position id/);
  });

  test('refuses an op outside set, delete, restore', () => {
    expect(() => parseOwnershipMutation({ op: 'update', id: '7' })).toThrow(/"op" must be one of/);
  });
});

// ---------------------------------------------------------------------------
// Exits (F4, ADR-036)
// ---------------------------------------------------------------------------

describe('parseExitMutation', () => {
  /**
   * ADR-036. Membership follows Affinity's roster status; this endpoint records
   * the economic event. There is no verb for marking a company exited, by
   * construction rather than by omission — an exited flag maintained in two
   * places would have the nightly sync silently winning the argument.
   */
  test('offers no way to mark a company exited', () => {
    for (const op of ['mark-exited', 'exit', 'set-roster-status']) {
      expect(() => parseExitMutation({ op, companyId: 'c1' })).toThrow(/"op" must be one of: record, remove/);
    }
  });

  test('removing an exit demands a reason', () => {
    expect(() => parseExitMutation({ op: 'remove', companyId: 'c1' }))
      .toThrow(/nobody can account for/);
    expect(parseExitMutation({ op: 'remove', companyId: 'c1', reason: 'keyed twice' }))
      .toMatchObject({ op: 'remove', companyId: 'c1', reason: 'keyed twice' });
  });

  test('recording an exit needs a values object and nothing more from this layer', () => {
    expect(() => parseExitMutation({ op: 'record' })).toThrow(/"values" must be an object/);
    expect(parseExitMutation({ op: 'record', values: { companyId: 'c1' } }).op).toBe('record');
  });
});

// ---------------------------------------------------------------------------
// Finance policies (F3, ADR-035 clause 5)
// ---------------------------------------------------------------------------

describe('parseFinancePolicyEdit', () => {
  /**
   * NULL IS A VALUE HERE AND `0` IS A DIFFERENT ONE.
   *
   * `null` is "no threshold in force", which makes the derived significant-
   * influence flag NULL for every company. `0` would flag every company we hold
   * an ownership figure for. A `?? 0` anywhere on this path collapses the first
   * into the second, silently, on the one screen where the difference is the
   * requirement.
   */
  test('does not coalesce a null significant-influence threshold', () => {
    const cleared = parseFinancePolicyEdit({ kind: 'accounting-policy', significantInfluencePct: null });
    expect((cleared as { significantInfluencePct: unknown }).significantInfluencePct).toBeNull();

    const zero = parseFinancePolicyEdit({ kind: 'accounting-policy', significantInfluencePct: 0 });
    expect((zero as { significantInfluencePct: unknown }).significantInfluencePct).toBe(0);

    const ten = parseFinancePolicyEdit({ kind: 'accounting-policy', significantInfluencePct: 10 });
    expect((ten as { significantInfluencePct: unknown }).significantInfluencePct).toBe(10);
  });

  test('refuses a threshold that is neither a number nor null', () => {
    expect(() => parseFinancePolicyEdit({ kind: 'accounting-policy', significantInfluencePct: '10' }))
      .toThrow(/10 means 10%/);
    expect(() => parseFinancePolicyEdit({ kind: 'accounting-policy' }))
      .toThrow(/no threshold in force/);
  });

  /**
   * The factor is a string end to end, deliberately: it is a `numeric` in the
   * database and parsing it into a float here is how 0.7500 becomes something
   * that no longer compares equal to the reference row it is validated against.
   */
  test('a retention option carries its factor as text', () => {
    const added = parseFinancePolicyEdit({
      kind: 'retention-option-add', factor: '0.60', label: '60% retained',
    });
    expect(added).toMatchObject({ factor: '0.60', label: '60% retained', sortOrder: null });
    expect(() => parseFinancePolicyEdit({ kind: 'retention-option-add', factor: 0.6, label: 'x' }))
      .toThrow(/"factor" is required/);
  });

  test('retiring an option demands an explicit boolean', () => {
    expect(() => parseFinancePolicyEdit({ kind: 'retention-option-active', factor: '0.60' }))
      .toThrow(/true to offer this option or false to retire it/);
    expect(parseFinancePolicyEdit({ kind: 'retention-option-active', factor: '0.60', isActive: false }))
      .toMatchObject({ isActive: false });
  });
});
