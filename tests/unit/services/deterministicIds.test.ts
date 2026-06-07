import { describe, expect, it } from 'vitest';
import {
  deterministicId,
  LEDGER_DECIMALS,
  normalizeLedgerNumber,
  normalizePositiveLedgerNumber,
} from '../../../lib/services/deterministicIds';
import { ValidationError } from '../../../lib/services/errors';

describe('ledger number normalization', () => {
  it('uses six decimal places', () => {
    expect(LEDGER_DECIMALS).toBe(6);
    expect(normalizeLedgerNumber(1.2)).toBe('1.200000');
    expect(normalizeLedgerNumber(1.2000001)).toBe('1.200000');
    expect(normalizeLedgerNumber(-2.3456789)).toBe('-2.345679');
  });

  it.each([-0, -0.0000001, -0.0000004])(
    'normalizes tiny negative value %s to canonical positive zero',
    (value) => {
      expect(normalizeLedgerNumber(value)).toBe('0.000000');
      expect(normalizeLedgerNumber(value)).not.toBe('-0.000000');
    }
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite value %s',
    (value) => {
      expect(() => normalizeLedgerNumber(value)).toThrow(ValidationError);
    }
  );

  it.each([1e21, -1e21, Number.MAX_VALUE, -Number.MAX_VALUE])(
    'rejects value %s that cannot be represented in fixed decimal notation',
    (value) => {
      expect(() => normalizeLedgerNumber(value)).toThrow(ValidationError);
    }
  );

  it('normalizes positive finite values', () => {
    expect(normalizePositiveLedgerNumber(1.2345678)).toBe('1.234568');
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0,
    -1,
    0.0000001,
  ])('rejects invalid positive ledger value %s', (value) => {
    expect(() => normalizePositiveLedgerNumber(value)).toThrow(
      ValidationError
    );
  });
});

describe('deterministicId', () => {
  it('hashes trimmed ordered components into a 32-character hex suffix', () => {
    expect(
      deterministicId('txn:xout:v1', [' t1 ', 'i1', ' lot1'])
    ).toBe('txn:xout:v1:f6c0b658557a3de069ef362c3b5e23b5');
  });

  it('returns the same ID for the same prefix and components', () => {
    expect(deterministicId('txn:xout:v1', ['t1', 'i1', 'lot1'])).toBe(
      deterministicId('txn:xout:v1', ['t1', 'i1', 'lot1'])
    );
  });

  it('changes when component order or content changes', () => {
    const original = deterministicId('txn:xout:v1', ['t1', 'i1', 'lot1']);

    expect(
      deterministicId('txn:xout:v1', ['t1', 'lot1', 'i1'])
    ).not.toBe(original);
    expect(
      deterministicId('txn:xout:v1', ['t1', 'i1', 'lot2'])
    ).not.toBe(original);
  });

  it.each([
    ['', ['t1']],
    ['   ', ['t1']],
    ['txn:xout:v1', []],
    ['txn:xout:v1', ['t1', '']],
    ['txn:xout:v1', ['t1', '   ']],
  ] as const)('rejects blank prefix or components', (prefix, components) => {
    expect(() => deterministicId(prefix, [...components])).toThrow(
      ValidationError
    );
  });

  it.each([
    ' txn:xout:v1',
    'txn:xout:v1 ',
    'Txn:xout:v1',
    'txn:Xout:v1',
    'txn:xout:V1',
    'txn:xöut:v1',
  ])('rejects non-canonical prefix %s', (prefix) => {
    expect(() => deterministicId(prefix, ['t1'])).toThrow(ValidationError);
  });
});
