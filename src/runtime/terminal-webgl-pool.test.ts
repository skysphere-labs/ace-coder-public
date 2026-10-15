import { describe, expect, it, vi } from 'vitest';
import { createWebglPool } from './terminal-webgl-pool';

type S = { id: number };
const s = (id: number): S => ({ id });

function makePool(max: number) {
  const created: S[] = [];
  const destroyed: S[] = [];
  const pool = createWebglPool<S>(max, {
    create: (session) => {
      created.push(session);
      return true;
    },
    destroy: (session) => {
      destroyed.push(session);
    },
  });
  return { pool, created, destroyed };
}

describe('terminal-webgl-pool', () => {
  it('caps holders at max and retires the least-recently-acquired first', () => {
    const { pool, destroyed } = makePool(3);
    const all = [s(0), s(1), s(2), s(3), s(4)];
    for (const x of all) expect(pool.acquire(x)).toBe(true);
    expect(pool.size()).toBe(3);
    // 0 and 1 were LRU when 3 and 4 arrived, in that order.
    expect(destroyed).toEqual([all[0], all[1]]);
    expect(pool.holders()).toEqual([all[2], all[3], all[4]]);
  });

  it('bumps an existing holder to most-recent instead of creating again', () => {
    const { pool, created, destroyed } = makePool(2);
    const [a, b, c] = [s(1), s(2), s(3)];
    pool.acquire(a);
    pool.acquire(b);
    pool.acquire(a); // bump — a must now outlive b
    expect(created).toEqual([a, b]);
    pool.acquire(c); // evicts b, not a
    expect(destroyed).toEqual([b]);
    expect(pool.holders()).toEqual([a, c]);
  });

  it('release retires exactly once and is idempotent for non-holders', () => {
    const { pool, destroyed } = makePool(2);
    const a = s(1);
    pool.acquire(a);
    pool.release(a);
    pool.release(a);
    pool.release(s(99)); // never held
    expect(destroyed).toEqual([a]);
    expect(pool.size()).toBe(0);
  });

  it('a released session can re-acquire and competes as most-recent', () => {
    const { pool, destroyed } = makePool(2);
    const [a, b, c] = [s(1), s(2), s(3)];
    pool.acquire(a);
    pool.acquire(b);
    pool.release(a);
    expect(pool.acquire(a)).toBe(true); // plain re-acquire under cap
    pool.acquire(c); // must evict b (LRU), not the just-promoted a
    expect(destroyed).toEqual([a, b]);
    expect(pool.holders()).toEqual([a, c]);
  });

  it('forget vacates the slot without calling destroy (context already dead)', () => {
    const { pool, destroyed } = makePool(2);
    const a = s(1);
    pool.acquire(a);
    pool.forget(a);
    expect(destroyed).toEqual([]);
    expect(pool.size()).toBe(0);
    // The slot is genuinely free for someone else.
    pool.acquire(s(2));
    pool.acquire(s(3));
    expect(pool.size()).toBe(2);
    expect(destroyed).toEqual([]);
  });

  it('a failed create takes no slot and evicts nobody extra', () => {
    let fail = false;
    const destroyed: S[] = [];
    const pool = createWebglPool<S>(2, {
      create: () => !fail,
      destroy: (x) => destroyed.push(x),
    });
    const [a, b, c] = [s(1), s(2), s(3)];
    pool.acquire(a);
    pool.acquire(b);
    fail = true;
    expect(pool.acquire(c)).toBe(false);
    // The eviction to make room still happened (a), but c holds nothing.
    expect(pool.size()).toBe(1);
    expect(pool.has(c)).toBe(false);
    fail = false;
    expect(pool.acquire(c)).toBe(true);
    expect(pool.holders()).toEqual([b, c]);
  });

  it('a throwing create is treated as failure, not a crash', () => {
    const pool = createWebglPool<S>(2, {
      create: () => {
        throw new Error('no GPU');
      },
      destroy: () => {},
    });
    expect(pool.acquire(s(1))).toBe(false);
    expect(pool.size()).toBe(0);
  });

  it('a throwing destroy never blocks the eviction or the release', () => {
    const destroy = vi.fn(() => {
      throw new Error('dispose blew up');
    });
    const pool = createWebglPool<S>(1, { create: () => true, destroy });
    const [a, b] = [s(1), s(2)];
    pool.acquire(a);
    expect(pool.acquire(b)).toBe(true); // eviction of a must not be aborted
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(pool.holders()).toEqual([b]);
    pool.release(b);
    expect(pool.size()).toBe(0);
  });

  it('eviction stays stable under sustained churn: never over cap, one retire per eviction', () => {
    const { pool, destroyed } = makePool(4);
    const all = Array.from({ length: 30 }, (_, i) => s(i));
    for (const x of all) {
      pool.acquire(x);
      expect(pool.size()).toBeLessThanOrEqual(4);
    }
    // 30 acquires through a 4-slot pool = exactly 26 evictions, each unique.
    expect(destroyed.length).toBe(26);
    expect(new Set(destroyed).size).toBe(26);
    expect(pool.holders()).toEqual(all.slice(26));
  });
});
