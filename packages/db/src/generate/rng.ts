/**
 * The deterministic generator's random source.
 *
 * `mulberry32` is the prototype's own PRNG, lifted verbatim from
 * `docs/reference/vc-toolkit.html:197` -- the roadmap names it as the precedent
 * for A6. It is a 32-bit state, so an identical seed reproduces an identical
 * dataset on any platform and any Node version, which is what makes the
 * generated data reviewable in a diff rather than merely plausible.
 *
 * PER-COMPANY SEEDING IS THE POINT. Each company draws from a stream seeded on
 * its own id, so adding a company, reordering the roster or regenerating one
 * position leaves every other company's history byte-identical. A single shared
 * stream would reshuffle the entire portfolio whenever Affinity gained a row.
 */

/** vc-toolkit.html:197, unchanged. */
export function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A stable 32-bit hash of a string, so `seedFor('C042')` is the same number
 * today and after a rebuild. FNV-1a: small, well-known, and no dependency.
 */
export function hashSeed(key: string, salt = 0): number {
  let h = 0x811c9dc5 ^ salt;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A small, deliberately boring drawing API over one stream. */
export class Rng {
  private readonly next: () => number;

  constructor(seed: number | string, salt = 0) {
    this.next = mulberry32(typeof seed === 'number' ? seed ^ salt : hashSeed(seed, salt));
  }

  /** Uniform in [0, 1). */
  unit(): number {
    return this.next();
  }

  /** Uniform in [lo, hi). */
  between(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  /** Uniform integer in [lo, hi], inclusive at both ends. */
  int(lo: number, hi: number): number {
    return Math.floor(this.between(lo, hi + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick() from an empty list');
    return items[Math.floor(this.next() * items.length)]!;
  }

  /**
   * Draws `n` weights that sum to 1, each at least `floor` of the total.
   *
   * Used to split a company's known total invested across its rounds. The floor
   * stops a five-round history from containing a $400 cheque, which reads as a
   * generator artefact rather than as a real tranche.
   */
  weights(n: number, floor = 0.08): number[] {
    const raw = Array.from({ length: n }, () => floor + this.next() * (1 - floor));
    const total = raw.reduce((a, b) => a + b, 0);
    return raw.map((w) => w / total);
  }
}
