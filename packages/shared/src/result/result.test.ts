import { describe, expect, it } from 'vitest';
import {
  all,
  andThen,
  err,
  fromPromise,
  fromThrowable,
  isErr,
  isOk,
  map,
  mapErr,
  match,
  ok,
  unwrap,
  unwrapOr,
} from './result.js';

describe('Result', () => {
  it('constructs and narrows Ok', () => {
    const result = ok(42);
    expect(isOk(result)).toBe(true);
    expect(isErr(result)).toBe(false);
    if (isOk(result)) expect(result.value).toBe(42);
  });

  it('constructs and narrows Err', () => {
    const result = err(new Error('boom'));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.message).toBe('boom');
  });

  it('maps success values and passes errors through', () => {
    expect(map(ok(2), (n) => n * 2)).toEqual(ok(4));
    const e = err<string>('bad');
    expect(map(e, (n: number) => n * 2)).toEqual(e);
  });

  it('maps error values and passes successes through', () => {
    expect(mapErr(err('bad'), (s) => s.toUpperCase())).toEqual(err('BAD'));
    expect(mapErr(ok(1), (s: string) => s)).toEqual(ok(1));
  });

  it('chains with andThen', () => {
    const parse = (s: string) =>
      Number.isNaN(Number(s)) ? err<string>('NaN') : ok<number>(Number(s));
    expect(andThen(ok('3'), parse)).toEqual(ok(3));
    expect(andThen(ok('x'), parse)).toEqual(err('NaN'));
  });

  it('unwrapOr returns fallback on error', () => {
    expect(unwrapOr(ok(1), 9)).toBe(1);
    expect(unwrapOr(err<string, number>('e'), 9)).toBe(9);
  });

  it('unwrap throws on error', () => {
    expect(unwrap(ok(5))).toBe(5);
    expect(() => unwrap(err(new Error('nope')))).toThrow('nope');
  });

  it('match collapses both branches', () => {
    expect(match(ok(2), { ok: (n) => n + 1, err: () => -1 })).toBe(3);
    expect(match(err<string, number>('e'), { ok: (n) => n, err: () => -1 })).toBe(-1);
  });

  it('fromThrowable captures thrown errors', () => {
    const good = fromThrowable(() => JSON.parse('{"a":1}') as { a: number });
    expect(good).toEqual(ok({ a: 1 }));
    const bad = fromThrowable(() => JSON.parse('{bad') as unknown);
    expect(isErr(bad)).toBe(true);
  });

  it('fromPromise captures rejections', async () => {
    expect(await fromPromise(Promise.resolve(1))).toEqual(ok(1));
    const failed = await fromPromise(Promise.reject(new Error('rejected')));
    expect(isErr(failed)).toBe(true);
  });

  it('all short-circuits on first error', () => {
    expect(all([ok(1), ok(2), ok(3)])).toEqual(ok([1, 2, 3]));
    expect(all([ok(1), err<string, number>('e'), ok(3)])).toEqual(err('e'));
  });
});
