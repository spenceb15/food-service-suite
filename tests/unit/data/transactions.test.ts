import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryTransaction } from '../../../lib/types';
import {
  IntegrityConflictError,
  RetryableMutationError,
} from '../../../lib/services/errors';

const sheetsMock = vi.hoisted(() => ({
  getRows: vi.fn(),
  appendRow: vi.fn(),
  updateRow: vi.fn(),
  deleteRow: vi.fn(),
}));

vi.mock('../../../lib/data/sheets', () => sheetsMock);

import {
  ensureTransaction,
  getCanonicalTransactions,
  transactionToRow,
} from '../../../lib/data/transactions';

function makeTransaction(
  overrides: Partial<InventoryTransaction> = {}
): InventoryTransaction {
  return {
    txn_id: 'txn:recv:v1:abc',
    timestamp: '2026-06-06T12:00:00.000Z',
    item_id: 'item-1',
    location_id: 'location-1',
    lot_id: 'lot-1',
    qty_base: 1.2,
    txn_type: 'receive',
    ref_type: 'receipt',
    ref_id: 'receipt-1',
    unit_cost: 2.5,
    user_id: 'user-1',
    note: 'receipt line 1',
    ...overrides,
  };
}

function rowsFor(...transactions: InventoryTransaction[]): string[][] {
  return transactions.map((transaction) =>
    transactionToRow(transaction).map(String)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('getCanonicalTransactions', () => {
  it('collapses identical physical rows and chooses the earliest audit row', async () => {
    sheetsMock.getRows.mockResolvedValue(
      rowsFor(
        makeTransaction({
          timestamp: '2026-06-06T12:00:02.000Z',
          qty_base: 1.2000001,
          unit_cost: 2.5000001,
          user_id: 'later-user',
        }),
        makeTransaction({
          timestamp: '2026-06-06T12:00:01.000Z',
          qty_base: 1.2,
          unit_cost: 2.5,
          user_id: 'first-user',
        })
      )
    );

    const result = await getCanonicalTransactions();

    expect(result).toEqual([
      makeTransaction({
        timestamp: '2026-06-06T12:00:01.000Z',
        user_id: 'first-user',
      }),
    ]);
    expect(result.reduce((sum, transaction) => sum + transaction.qty_base, 0))
      .toBe(1.2);
  });

  it.each([
    ['item_id', { item_id: 'item-2' }],
    ['location_id', { location_id: 'location-2' }],
    ['lot_id', { lot_id: 'lot-2' }],
    ['qty_base', { qty_base: 1.200002 }],
    ['txn_type', { txn_type: 'yield' as const }],
    ['ref_type', { ref_type: 'order' as const }],
    ['ref_id', { ref_id: 'receipt-2' }],
    ['unit_cost', { unit_cost: 2.500002 }],
    ['note', { note: 'different effect' }],
  ])(
    'throws when duplicate IDs conflict on %s',
    async (_field, conflictingFields) => {
      sheetsMock.getRows.mockResolvedValue(
        rowsFor(
          makeTransaction(),
          makeTransaction({
            timestamp: '2026-06-06T12:00:01.000Z',
            user_id: 'user-2',
            ...conflictingFields,
          })
        )
      );

      await expect(getCanonicalTransactions()).rejects.toBeInstanceOf(
        IntegrityConflictError
      );
    }
  );

  it('fails closed when a physical row has a blank transaction ID', async () => {
    sheetsMock.getRows.mockResolvedValue(
      rowsFor(makeTransaction({ txn_id: '' }))
    );

    await expect(getCanonicalTransactions()).rejects.toBeInstanceOf(
      IntegrityConflictError
    );
  });

  it('reports a typed integrity conflict for a completely blank row', async () => {
    sheetsMock.getRows.mockResolvedValue([[]]);

    await expect(getCanonicalTransactions()).rejects.toBeInstanceOf(
      IntegrityConflictError
    );
  });
});

describe('ensureTransaction', () => {
  it('appends the caller-supplied ID with server audit metadata when absent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-06T13:00:00.000Z'));

    const expected = {
      ...makeTransaction(),
      timestamp: undefined,
      user_id: undefined,
    };
    delete expected.timestamp;
    delete expected.user_id;

    sheetsMock.getRows
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(
        rowsFor(
          makeTransaction({
            timestamp: '2026-06-06T13:00:00.000Z',
            user_id: 'server-user',
          })
        )
      );

    const result = await ensureTransaction(expected, 'server-user');

    expect(sheetsMock.appendRow).toHaveBeenCalledWith('Transactions', [
      'txn:recv:v1:abc',
      '2026-06-06T13:00:00.000Z',
      'item-1',
      'location-1',
      'lot-1',
      1.2,
      'receive',
      'receipt',
      'receipt-1',
      2.5,
      'server-user',
      'receipt line 1',
    ]);
    expect(result).toEqual({
      value: makeTransaction({
        timestamp: '2026-06-06T13:00:00.000Z',
        user_id: 'server-user',
      }),
      outcome: 'created',
    });
  });

  it('returns an identical existing transaction without replacing audit metadata', async () => {
    const existing = makeTransaction({
      timestamp: '2026-06-01T08:00:00.000Z',
      qty_base: 1.2000001,
      unit_cost: 2.5000001,
      user_id: 'first-user',
    });
    sheetsMock.getRows.mockResolvedValue(rowsFor(existing));

    const expected = {
      ...makeTransaction({
        qty_base: 1.2,
        unit_cost: 2.5,
        user_id: 'retry-user',
      }),
    };
    delete (expected as Partial<InventoryTransaction>).timestamp;

    const result = await ensureTransaction(expected, 'server-user');

    expect(result).toEqual({ value: existing, outcome: 'existing' });
    expect(sheetsMock.appendRow).not.toHaveBeenCalled();
  });

  it('throws when the expected effect conflicts with an existing transaction ID', async () => {
    sheetsMock.getRows.mockResolvedValue(
      rowsFor(makeTransaction({ qty_base: 10 }))
    );
    const expected = { ...makeTransaction({ qty_base: 9 }) };
    delete (expected as Partial<InventoryTransaction>).timestamp;

    await expect(ensureTransaction(expected)).rejects.toBeInstanceOf(
      IntegrityConflictError
    );
    expect(sheetsMock.appendRow).not.toHaveBeenCalled();
  });

  it('throws a retryable error when the appended transaction is still missing', async () => {
    sheetsMock.getRows
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const expected = { ...makeTransaction() };
    delete (expected as Partial<InventoryTransaction>).timestamp;

    await expect(ensureTransaction(expected)).rejects.toBeInstanceOf(
      RetryableMutationError
    );
    expect(sheetsMock.appendRow).toHaveBeenCalledOnce();
  });

  it('preserves append-only storage by never updating or deleting rows', async () => {
    sheetsMock.getRows.mockResolvedValue(rowsFor(makeTransaction()));
    const expected = { ...makeTransaction() };
    delete (expected as Partial<InventoryTransaction>).timestamp;

    await ensureTransaction(expected);

    expect(sheetsMock.updateRow).not.toHaveBeenCalled();
    expect(sheetsMock.deleteRow).not.toHaveBeenCalled();
  });
});
