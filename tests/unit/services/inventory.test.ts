/**
 * Unit tests for lib/services/inventory.ts
 *
 * All Google Sheets I/O is mocked via vi.mock. No real network calls are made.
 *
 * Coverage targets:
 *  - getOnHand: signed ledger sum, mixed signs, empty
 *  - getInventoryValue: lot value rollup, excludes zero-remaining lots
 *  - consumeFIFO: single lot, multi-lot, insufficient stock (no writes), FIFO ordering
 *  - postTransaction: delegates to appendTransaction, returns full txn
 *  - getLots: excludes zero-remaining, returns ascending by received_date
 *  - getMovementHistory: descending by timestamp, location filter (now required)
 *  - Access control: session.assignedLocationIds enforcement
 *  - Input validation: NaN qty, empty IDs, sign convention, NaN unit_cost
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Lot, InventoryTransaction } from '../../../lib/types';
import { Role } from '../../../lib/types';
import type { Session } from '../../../lib/types';

// ─── Mocks ────────────────────────────────────────────────────────────────────
// Must be declared before the service import so Vitest hoists them correctly.

vi.mock('../../../lib/data/lots', () => ({
  getAllLots: vi.fn(),
  updateLot: vi.fn(),
  getCanonicalLots: vi.fn(),
  setLotRemainingById: vi.fn(),
  ensureLot: vi.fn(),
}));

vi.mock('../../../lib/data/transactions', () => ({
  getAllTransactions: vi.fn(),
  appendTransaction: vi.fn(),
  getCanonicalTransactions: vi.fn(),
  ensureTransaction: vi.fn(),
}));

// Import mocked modules so we can set return values per test.
import { getAllLots, updateLot, getCanonicalLots, setLotRemainingById, ensureLot } from '../../../lib/data/lots';
import { getAllTransactions, appendTransaction, getCanonicalTransactions, ensureTransaction } from '../../../lib/data/transactions';

// Import the service under test AFTER mocks are wired.
import {
  getOnHand,
  getInventoryValue,
  consumeFIFO,
  postTransaction,
  getLots,
  getMovementHistory,
  reconcileLotBalance,
  ensureInboundPortion,
  reconcileFifoOutflow,
} from '../../../lib/services/inventory';

// ─── Stub session ─────────────────────────────────────────────────────────────

const stubSession: Session = {
  userId: 'user-1',
  role: Role.director_admin,
  assignedLocationIds: 'all',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeLot(overrides: Partial<Lot> & { lot_id: string }): Lot {
  return {
    item_id: 'item-001',
    location_id: 'loc-001',
    received_date: '2026-01-01',
    original_qty: 100,
    remaining_qty: 100,
    unit_cost: 2.0,
    source_ref: 'receipt-001',
    ...overrides,
  };
}

function makeTxn(
  overrides: Partial<InventoryTransaction> & { txn_id: string }
): InventoryTransaction {
  return {
    timestamp: '2026-06-01T00:00:00Z',
    item_id: 'item-001',
    location_id: 'loc-001',
    qty_base: 10,
    txn_type: 'receive',
    ref_type: 'receipt',
    ref_id: 'receipt-001',
    unit_cost: 2.0,
    user_id: 'user-001',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: appendTransaction echoes back a full transaction object.
  vi.mocked(appendTransaction).mockImplementation(async (data) => ({
    txn_id: 'generated-txn-id',
    timestamp: '2026-06-06T00:00:00Z',
    ...data,
  }));
  vi.mocked(updateLot).mockResolvedValue(undefined);
  vi.mocked(setLotRemainingById).mockResolvedValue(undefined);
  vi.mocked(ensureLot).mockImplementation(async (lot) => ({
    value: lot,
    outcome: 'created' as const,
  }));
  vi.mocked(ensureTransaction).mockImplementation(async (txn) => ({
    value: { ...txn, timestamp: '2026-06-06T00:00:00Z', user_id: txn.user_id ?? 'user-1' } as import('../../../lib/types').InventoryTransaction,
    outcome: 'created' as const,
  }));
  vi.mocked(getCanonicalTransactions).mockResolvedValue([]);
  vi.mocked(getCanonicalLots).mockResolvedValue([]);
});

// ─── getOnHand ────────────────────────────────────────────────────────────────

describe('getOnHand', () => {
  it('returns 0 when there are no transactions for the item+location', async () => {
    vi.mocked(getCanonicalTransactions).mockResolvedValue([]);
    expect(await getOnHand('item-001', 'loc-001', stubSession)).toBe(0);
  });

  it('sums positive qty_base values (inflows)', async () => {
    vi.mocked(getCanonicalTransactions).mockResolvedValue([
      makeTxn({ txn_id: 't1', qty_base: 50 }),
      makeTxn({ txn_id: 't2', qty_base: 30 }),
    ]);
    expect(await getOnHand('item-001', 'loc-001', stubSession)).toBe(80);
  });

  it('sums signed qty_base correctly with mixed inflows and outflows', async () => {
    vi.mocked(getCanonicalTransactions).mockResolvedValue([
      makeTxn({ txn_id: 't1', qty_base: 100 }),   // receive
      makeTxn({ txn_id: 't2', qty_base: -30 }),    // consume
      makeTxn({ txn_id: 't3', qty_base: -10 }),    // consume
      makeTxn({ txn_id: 't4', qty_base: 5 }),      // count_adjust
    ]);
    expect(await getOnHand('item-001', 'loc-001', stubSession)).toBe(65);
  });

  it('ignores transactions for other items', async () => {
    vi.mocked(getCanonicalTransactions).mockResolvedValue([
      makeTxn({ txn_id: 't1', item_id: 'item-001', qty_base: 100 }),
      makeTxn({ txn_id: 't2', item_id: 'item-002', qty_base: 50 }),
    ]);
    expect(await getOnHand('item-001', 'loc-001', stubSession)).toBe(100);
  });

  it('ignores transactions for other locations', async () => {
    vi.mocked(getCanonicalTransactions).mockResolvedValue([
      makeTxn({ txn_id: 't1', location_id: 'loc-001', qty_base: 100 }),
      makeTxn({ txn_id: 't2', location_id: 'loc-002', qty_base: 200 }),
    ]);
    expect(await getOnHand('item-001', 'loc-001', stubSession)).toBe(100);
  });

  it('returns a negative total when outflows exceed inflows', async () => {
    vi.mocked(getCanonicalTransactions).mockResolvedValue([
      makeTxn({ txn_id: 't1', qty_base: 10 }),
      makeTxn({ txn_id: 't2', qty_base: -25 }),
    ]);
    // Negative on-hand is possible from adjustments; the ledger doesn't lie.
    expect(await getOnHand('item-001', 'loc-001', stubSession)).toBe(-15);
  });

  it('throws when session does not have access to the location', async () => {
    const restrictedSession: Session = {
      userId: 'user-2',
      role: Role.kitchen_manager,
      assignedLocationIds: ['loc-999'],
    };
    vi.mocked(getCanonicalTransactions).mockResolvedValue([]);
    await expect(
      getOnHand('item-001', 'loc-001', restrictedSession)
    ).rejects.toThrow('Access denied');
  });
});

// ─── getInventoryValue ────────────────────────────────────────────────────────

describe('getInventoryValue', () => {
  it('returns 0 when there are no lots at the location', async () => {
    vi.mocked(getCanonicalLots).mockResolvedValue([]);
    expect(await getInventoryValue('loc-001', stubSession)).toBe(0);
  });

  it('sums remaining_qty × unit_cost across lots', async () => {
    vi.mocked(getCanonicalLots).mockResolvedValue([
      makeLot({ lot_id: 'lot-1', remaining_qty: 10, unit_cost: 3.0 }),  // 30
      makeLot({ lot_id: 'lot-2', remaining_qty: 5, unit_cost: 4.0 }),   // 20
    ]);
    expect(await getInventoryValue('loc-001', stubSession)).toBeCloseTo(50);
  });

  it('excludes lots with remaining_qty of 0', async () => {
    vi.mocked(getCanonicalLots).mockResolvedValue([
      makeLot({ lot_id: 'lot-1', remaining_qty: 10, unit_cost: 3.0 }),
      makeLot({ lot_id: 'lot-2', remaining_qty: 0, unit_cost: 100.0 }), // exhausted — excluded
    ]);
    expect(await getInventoryValue('loc-001', stubSession)).toBeCloseTo(30);
  });

  it('ignores lots belonging to other locations', async () => {
    vi.mocked(getCanonicalLots).mockResolvedValue([
      makeLot({ lot_id: 'lot-1', location_id: 'loc-001', remaining_qty: 10, unit_cost: 2.0 }),
      makeLot({ lot_id: 'lot-2', location_id: 'loc-002', remaining_qty: 50, unit_cost: 5.0 }),
    ]);
    expect(await getInventoryValue('loc-001', stubSession)).toBeCloseTo(20);
  });

  it('throws when session does not have access to the location', async () => {
    const restrictedSession: Session = {
      userId: 'user-2',
      role: Role.kitchen_manager,
      assignedLocationIds: ['loc-999'],
    };
    vi.mocked(getCanonicalLots).mockResolvedValue([]);
    await expect(
      getInventoryValue('loc-001', restrictedSession)
    ).rejects.toThrow('Access denied');
  });
});

// ─── consumeFIFO — single lot ─────────────────────────────────────────────────

describe('consumeFIFO — single lot', () => {
  it('depletes a single lot exactly, posts one negative transaction, returns breakdown', async () => {
    vi.mocked(getAllLots).mockResolvedValue([
      makeLot({ lot_id: 'lot-1', remaining_qty: 50, unit_cost: 2.5 }),
    ]);

    const result = await consumeFIFO({
      itemId: 'item-001',
      locationId: 'loc-001',
      qty: 50,
      txnType: 'consume',
      refType: 'manual',
      refId: 'ref-001',
      session: stubSession,
    });

    // Lot should be updated to 0 remaining.
    expect(updateLot).toHaveBeenCalledOnce();
    expect(updateLot).toHaveBeenCalledWith('lot-1', 0);

    // One transaction posted with negative qty_base.
    expect(appendTransaction).toHaveBeenCalledOnce();
    const txnArg = vi.mocked(appendTransaction).mock.calls[0][0];
    expect(txnArg.qty_base).toBe(-50);
    expect(txnArg.lot_id).toBe('lot-1');
    expect(txnArg.unit_cost).toBe(2.5);

    // Return value breakdown.
    expect(result.lotConsumed).toHaveLength(1);
    expect(result.lotConsumed[0]).toEqual({ lotId: 'lot-1', qty: 50, unitCost: 2.5 });
  });

  it('partially consumes a lot, leaving the remainder', async () => {
    vi.mocked(getAllLots).mockResolvedValue([
      makeLot({ lot_id: 'lot-1', remaining_qty: 100, unit_cost: 1.0 }),
    ]);

    const result = await consumeFIFO({
      itemId: 'item-001',
      locationId: 'loc-001',
      qty: 40,
      txnType: 'consume',
      refType: 'manual',
      refId: 'ref-002',
      session: stubSession,
    });

    expect(updateLot).toHaveBeenCalledWith('lot-1', 60);

    const txnArg = vi.mocked(appendTransaction).mock.calls[0][0];
    expect(txnArg.qty_base).toBe(-40);

    expect(result.lotConsumed[0].qty).toBe(40);
  });

  it('uses session.userId as user_id on the transaction (not caller-supplied)', async () => {
    vi.mocked(getAllLots).mockResolvedValue([
      makeLot({ lot_id: 'lot-1', remaining_qty: 10, unit_cost: 1.0 }),
    ]);

    await consumeFIFO({
      itemId: 'item-001',
      locationId: 'loc-001',
      qty: 5,
      txnType: 'consume',
      refType: 'manual',
      refId: 'ref-uid',
      session: { userId: 'session-user', role: Role.warehouse, assignedLocationIds: 'all' },
    });

    const txnArg = vi.mocked(appendTransaction).mock.calls[0][0];
    expect(txnArg.user_id).toBe('session-user');
  });
});

// ─── consumeFIFO — multi-lot ──────────────────────────────────────────────────

describe('consumeFIFO — multi-lot', () => {
  it('exhausts the oldest lot first, then partially consumes the next', async () => {
    vi.mocked(getAllLots).mockResolvedValue([
      makeLot({ lot_id: 'lot-old', received_date: '2026-01-01', remaining_qty: 30, unit_cost: 1.0 }),
      makeLot({ lot_id: 'lot-new', received_date: '2026-03-01', remaining_qty: 50, unit_cost: 1.5 }),
    ]);

    const result = await consumeFIFO({
      itemId: 'item-001',
      locationId: 'loc-001',
      qty: 45,
      txnType: 'consume',
      refType: 'manual',
      refId: 'ref-003',
      session: stubSession,
    });

    // Two lot updates.
    expect(updateLot).toHaveBeenCalledTimes(2);
    expect(updateLot).toHaveBeenNthCalledWith(1, 'lot-old', 0);   // exhausted
    expect(updateLot).toHaveBeenNthCalledWith(2, 'lot-new', 35);  // 50 - 15

    // Two transactions posted.
    expect(appendTransaction).toHaveBeenCalledTimes(2);
    const [call1, call2] = vi.mocked(appendTransaction).mock.calls;
    expect(call1[0].qty_base).toBe(-30);
    expect(call1[0].unit_cost).toBe(1.0);
    expect(call2[0].qty_base).toBe(-15);
    expect(call2[0].unit_cost).toBe(1.5);

    // Return breakdown.
    expect(result.lotConsumed).toHaveLength(2);
    expect(result.lotConsumed[0]).toEqual({ lotId: 'lot-old', qty: 30, unitCost: 1.0 });
    expect(result.lotConsumed[1]).toEqual({ lotId: 'lot-new', qty: 15, unitCost: 1.5 });
  });

  it('spans three lots when two are not enough', async () => {
    vi.mocked(getAllLots).mockResolvedValue([
      makeLot({ lot_id: 'lot-a', received_date: '2026-01-01', remaining_qty: 10, unit_cost: 1.0 }),
      makeLot({ lot_id: 'lot-b', received_date: '2026-02-01', remaining_qty: 10, unit_cost: 2.0 }),
      makeLot({ lot_id: 'lot-c', received_date: '2026-03-01', remaining_qty: 10, unit_cost: 3.0 }),
    ]);

    const result = await consumeFIFO({
      itemId: 'item-001',
      locationId: 'loc-001',
      qty: 25,
      txnType: 'consume',
      refType: 'manual',
      refId: 'ref-004',
      session: stubSession,
    });

    expect(updateLot).toHaveBeenCalledTimes(3);
    expect(result.lotConsumed).toHaveLength(3);
    expect(result.lotConsumed[0]).toEqual({ lotId: 'lot-a', qty: 10, unitCost: 1.0 });
    expect(result.lotConsumed[1]).toEqual({ lotId: 'lot-b', qty: 10, unitCost: 2.0 });
    expect(result.lotConsumed[2]).toEqual({ lotId: 'lot-c', qty: 5, unitCost: 3.0 });
  });
});

// ─── consumeFIFO — insufficient stock ────────────────────────────────────────

describe('consumeFIFO — insufficient stock', () => {
  it('rejects waste from roles not allowed to record waste', async () => {
    const kitchenSession: Session = {
      userId: 'kitchen-user',
      role: Role.kitchen_manager,
      assignedLocationIds: 'all',
    };

    await expect(
      consumeFIFO({
        itemId: 'item-001',
        locationId: 'loc-001',
        qty: 1,
        txnType: 'waste',
        refType: 'manual',
        refId: 'waste-001',
        session: kitchenSession,
      })
    ).rejects.toThrow('Access denied');

    expect(getAllLots).not.toHaveBeenCalled();
    expect(updateLot).not.toHaveBeenCalled();
    expect(appendTransaction).not.toHaveBeenCalled();
  });

  it('rejects non-FIFO transaction types before reading or writing inventory', async () => {
    await expect(
      consumeFIFO({
        itemId: 'item-001',
        locationId: 'loc-001',
        qty: 10,
        txnType: 'receive',
        refType: 'receipt',
        refId: 'ref-invalid-type',
        session: stubSession,
      })
    ).rejects.toThrow(
      'consumeFIFO only supports consume, sell, transfer_out, or waste'
    );

    expect(getAllLots).not.toHaveBeenCalled();
    expect(updateLot).not.toHaveBeenCalled();
    expect(appendTransaction).not.toHaveBeenCalled();
  });

  it('throws before writing anything when stock is insufficient', async () => {
    vi.mocked(getAllLots).mockResolvedValue([
      makeLot({ lot_id: 'lot-1', remaining_qty: 20, unit_cost: 1.0 }),
    ]);

    await expect(
      consumeFIFO({
        itemId: 'item-001',
        locationId: 'loc-001',
        qty: 50, // more than available
        txnType: 'consume',
        refType: 'manual',
        refId: 'ref-005',
        session: stubSession,
      })
    ).rejects.toThrow('Insufficient stock');

    // The pre-check must prevent any writes.
    expect(updateLot).not.toHaveBeenCalled();
    expect(appendTransaction).not.toHaveBeenCalled();
  });

  it('throws when there are no lots at all for the item+location', async () => {
    vi.mocked(getAllLots).mockResolvedValue([]);

    await expect(
      consumeFIFO({
        itemId: 'item-001',
        locationId: 'loc-001',
        qty: 1,
        txnType: 'consume',
        refType: 'manual',
        refId: 'ref-006',
        session: stubSession,
      })
    ).rejects.toThrow('Insufficient stock');

    expect(updateLot).not.toHaveBeenCalled();
    expect(appendTransaction).not.toHaveBeenCalled();
  });

  it('throws when all lots at the location are exhausted (remaining_qty = 0)', async () => {
    vi.mocked(getAllLots).mockResolvedValue([
      makeLot({ lot_id: 'lot-1', remaining_qty: 0 }),
      makeLot({ lot_id: 'lot-2', remaining_qty: 0 }),
    ]);

    await expect(
      consumeFIFO({
        itemId: 'item-001',
        locationId: 'loc-001',
        qty: 1,
        txnType: 'consume',
        refType: 'manual',
        refId: 'ref-007',
        session: stubSession,
      })
    ).rejects.toThrow('Insufficient stock');

    expect(updateLot).not.toHaveBeenCalled();
    expect(appendTransaction).not.toHaveBeenCalled();
  });

  it('throws for a non-positive qty parameter', async () => {
    vi.mocked(getAllLots).mockResolvedValue([
      makeLot({ lot_id: 'lot-1', remaining_qty: 100 }),
    ]);

    await expect(
      consumeFIFO({
        itemId: 'item-001',
        locationId: 'loc-001',
        qty: 0,
        txnType: 'consume',
        refType: 'manual',
        refId: 'ref-008',
        session: stubSession,
      })
    ).rejects.toThrow('qty must be a positive finite number');

    expect(updateLot).not.toHaveBeenCalled();
    expect(appendTransaction).not.toHaveBeenCalled();
  });

  it('throws for NaN qty and makes no writes (H3)', async () => {
    vi.mocked(getAllLots).mockResolvedValue([
      makeLot({ lot_id: 'lot-1', remaining_qty: 100 }),
    ]);

    await expect(
      consumeFIFO({
        itemId: 'item-001',
        locationId: 'loc-001',
        qty: NaN,
        txnType: 'consume',
        refType: 'manual',
        refId: 'ref-nan',
        session: stubSession,
      })
    ).rejects.toThrow('qty must be a positive finite number');

    expect(updateLot).not.toHaveBeenCalled();
    expect(appendTransaction).not.toHaveBeenCalled();
  });

  it('throws for empty itemId (H4)', async () => {
    vi.mocked(getAllLots).mockResolvedValue([]);

    await expect(
      consumeFIFO({
        itemId: '   ',
        locationId: 'loc-001',
        qty: 10,
        txnType: 'consume',
        refType: 'manual',
        refId: 'ref-empty-item',
        session: stubSession,
      })
    ).rejects.toThrow('itemId must be non-empty');

    expect(updateLot).not.toHaveBeenCalled();
    expect(appendTransaction).not.toHaveBeenCalled();
  });

  it('throws when session does not have access to the location (H1)', async () => {
    const restrictedSession: Session = {
      userId: 'user-2',
      role: Role.kitchen_manager,
      assignedLocationIds: ['loc-999'],
    };
    vi.mocked(getAllLots).mockResolvedValue([
      makeLot({ lot_id: 'lot-1', remaining_qty: 100 }),
    ]);

    await expect(
      consumeFIFO({
        itemId: 'item-001',
        locationId: 'loc-001',
        qty: 10,
        txnType: 'consume',
        refType: 'manual',
        refId: 'ref-access',
        session: restrictedSession,
      })
    ).rejects.toThrow('Access denied');

    expect(updateLot).not.toHaveBeenCalled();
    expect(appendTransaction).not.toHaveBeenCalled();
  });
});

// ─── consumeFIFO — FIFO ordering ─────────────────────────────────────────────

describe('consumeFIFO — FIFO ordering', () => {
  it('consumes the oldest received_date lot first, regardless of insertion order', async () => {
    // Lots returned out of chronological order from the data layer.
    vi.mocked(getAllLots).mockResolvedValue([
      makeLot({ lot_id: 'lot-newest', received_date: '2026-05-01', remaining_qty: 50, unit_cost: 5.0 }),
      makeLot({ lot_id: 'lot-oldest', received_date: '2026-01-01', remaining_qty: 50, unit_cost: 1.0 }),
      makeLot({ lot_id: 'lot-middle', received_date: '2026-03-01', remaining_qty: 50, unit_cost: 3.0 }),
    ]);

    const result = await consumeFIFO({
      itemId: 'item-001',
      locationId: 'loc-001',
      qty: 60,
      txnType: 'consume',
      refType: 'manual',
      refId: 'ref-009',
      session: stubSession,
    });

    // First lot consumed must be the oldest.
    expect(result.lotConsumed[0].lotId).toBe('lot-oldest');
    expect(result.lotConsumed[0].qty).toBe(50);
    expect(result.lotConsumed[0].unitCost).toBe(1.0);

    // Second lot consumed must be the middle one.
    expect(result.lotConsumed[1].lotId).toBe('lot-middle');
    expect(result.lotConsumed[1].qty).toBe(10);
    expect(result.lotConsumed[1].unitCost).toBe(3.0);

    // Newest lot must not be touched at all.
    const touchedLotIds = vi.mocked(updateLot).mock.calls.map((c) => c[0]);
    expect(touchedLotIds).not.toContain('lot-newest');
  });

  it('ignores exhausted lots (remaining_qty = 0) when ordering', async () => {
    vi.mocked(getAllLots).mockResolvedValue([
      makeLot({ lot_id: 'lot-empty', received_date: '2025-12-01', remaining_qty: 0, unit_cost: 1.0 }),
      makeLot({ lot_id: 'lot-active', received_date: '2026-01-15', remaining_qty: 20, unit_cost: 2.0 }),
    ]);

    const result = await consumeFIFO({
      itemId: 'item-001',
      locationId: 'loc-001',
      qty: 10,
      txnType: 'consume',
      refType: 'manual',
      refId: 'ref-010',
      session: stubSession,
    });

    // Only the active lot should be touched.
    expect(result.lotConsumed).toHaveLength(1);
    expect(result.lotConsumed[0].lotId).toBe('lot-active');
    expect(updateLot).toHaveBeenCalledOnce();
    expect(updateLot).toHaveBeenCalledWith('lot-active', 10);
  });
});

// ─── consumeFIFO — note sanitization ─────────────────────────────────────────

describe('consumeFIFO — note sanitization (M1)', () => {
  it('prepends a single-quote to notes starting with a formula character', async () => {
    vi.mocked(getAllLots).mockResolvedValue([
      makeLot({ lot_id: 'lot-1', remaining_qty: 10, unit_cost: 1.0 }),
    ]);

    await consumeFIFO({
      itemId: 'item-001',
      locationId: 'loc-001',
      qty: 5,
      txnType: 'consume',
      refType: 'manual',
      refId: 'ref-note',
      note: '=DANGEROUS()',
      session: stubSession,
    });

    const txnArg = vi.mocked(appendTransaction).mock.calls[0][0];
    expect(txnArg.note).toBe("'=DANGEROUS()");
  });

  it('leaves safe notes unchanged', async () => {
    vi.mocked(getAllLots).mockResolvedValue([
      makeLot({ lot_id: 'lot-1', remaining_qty: 10, unit_cost: 1.0 }),
    ]);

    await consumeFIFO({
      itemId: 'item-001',
      locationId: 'loc-001',
      qty: 5,
      txnType: 'consume',
      refType: 'manual',
      refId: 'ref-note-safe',
      note: 'Normal note',
      session: stubSession,
    });

    const txnArg = vi.mocked(appendTransaction).mock.calls[0][0];
    expect(txnArg.note).toBe('Normal note');
  });
});

// ─── postTransaction ──────────────────────────────────────────────────────────

describe('postTransaction', () => {
  it('stamps user_id from the session instead of caller-supplied identity', async () => {
    const spoofedInput = {
      item_id: 'item-001',
      location_id: 'loc-001',
      qty_base: 100,
      txn_type: 'receive' as const,
      ref_type: 'receipt' as const,
      ref_id: 'receipt-001',
      unit_cost: 3.0,
      user_id: 'spoofed-user',
    } as unknown as Parameters<typeof postTransaction>[0];

    await postTransaction(spoofedInput, {
      ...stubSession,
      userId: 'session-user',
    });

    expect(appendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'session-user' })
    );
  });

  it('delegates to appendTransaction and returns the full transaction', async () => {
    const input = {
      item_id: 'item-001',
      location_id: 'loc-001',
      qty_base: 100,
      txn_type: 'receive' as const,
      ref_type: 'receipt' as const,
      ref_id: 'receipt-001',
      unit_cost: 3.0,
    };

    const returned = await postTransaction(input, stubSession);

    expect(appendTransaction).toHaveBeenCalledOnce();

    // appendTransaction mock returns { txn_id: 'generated-txn-id', timestamp: ..., ...input }
    expect(returned.txn_id).toBe('generated-txn-id');
    expect(returned.qty_base).toBe(100);
    expect(returned.txn_type).toBe('receive');
  });

  it('passes the note field through when provided', async () => {
    const input = {
      item_id: 'item-001',
      location_id: 'loc-001',
      qty_base: 5,
      txn_type: 'count_adjust' as const,
      ref_type: 'manual' as const,
      ref_id: 'adj-001',
      unit_cost: 1.0,
      note: 'Spoilage during storage',
    };

    await postTransaction(input, stubSession);

    const arg = vi.mocked(appendTransaction).mock.calls[0][0];
    expect(arg.note).toBe('Spoilage during storage');
  });

  it('throws when qty_base is 0 (H2)', async () => {
    await expect(
      postTransaction(
        {
          item_id: 'item-001',
          location_id: 'loc-001',
          qty_base: 0,
          txn_type: 'receive',
          ref_type: 'receipt',
          ref_id: 'r-001',
          unit_cost: 1.0,
        },
        stubSession
      )
    ).rejects.toThrow('qty_base must be a finite non-zero number');
    expect(appendTransaction).not.toHaveBeenCalled();
  });

  it('throws when qty_base is NaN (H2)', async () => {
    await expect(
      postTransaction(
        {
          item_id: 'item-001',
          location_id: 'loc-001',
          qty_base: NaN,
          txn_type: 'receive',
          ref_type: 'receipt',
          ref_id: 'r-001',
          unit_cost: 1.0,
        },
        stubSession
      )
    ).rejects.toThrow('qty_base must be a finite non-zero number');
    expect(appendTransaction).not.toHaveBeenCalled();
  });

  it('throws when unit_cost is NaN (H2)', async () => {
    await expect(
      postTransaction(
        {
          item_id: 'item-001',
          location_id: 'loc-001',
          qty_base: 10,
          txn_type: 'receive',
          ref_type: 'receipt',
          ref_id: 'r-001',
          unit_cost: NaN,
        },
        stubSession
      )
    ).rejects.toThrow('unit_cost must be a non-negative finite number');
    expect(appendTransaction).not.toHaveBeenCalled();
  });

  it('throws when consume txn_type has positive qty_base — sign violation (H2)', async () => {
    await expect(
      postTransaction(
        {
          item_id: 'item-001',
          location_id: 'loc-001',
          qty_base: 10,   // wrong sign for an outflow
          txn_type: 'consume',
          ref_type: 'manual',
          ref_id: 'r-002',
          unit_cost: 1.0,
        },
        stubSession
      )
    ).rejects.toThrow('consume must have negative qty_base');
    expect(appendTransaction).not.toHaveBeenCalled();
  });

  it('throws when consume is passed directly — must go through consumeFIFO', async () => {
    await expect(
      postTransaction(
        {
          item_id: 'item-001',
          location_id: 'loc-001',
          qty_base: -10,
          txn_type: 'consume',
          ref_type: 'manual',
          ref_id: 'r-fifo-consume',
          unit_cost: 1.0,
        },
        stubSession
      )
    ).rejects.toThrow('consume must be posted through consumeFIFO to enforce FIFO lot selection');
    expect(appendTransaction).not.toHaveBeenCalled();
  });

  it('throws when sell is passed directly — must go through consumeFIFO', async () => {
    await expect(
      postTransaction(
        {
          item_id: 'item-001',
          location_id: 'loc-001',
          qty_base: -5,
          txn_type: 'sell',
          ref_type: 'manual',
          ref_id: 'r-fifo-sell',
          unit_cost: 1.0,
        },
        stubSession
      )
    ).rejects.toThrow('sell must be posted through consumeFIFO to enforce FIFO lot selection');
    expect(appendTransaction).not.toHaveBeenCalled();
  });

  it('throws when transfer_out is passed directly — must go through consumeFIFO', async () => {
    await expect(
      postTransaction(
        {
          item_id: 'item-001',
          location_id: 'loc-001',
          qty_base: -20,
          txn_type: 'transfer_out',
          ref_type: 'transfer',
          ref_id: 'r-fifo-transfer-out',
          unit_cost: 1.0,
        },
        stubSession
      )
    ).rejects.toThrow('transfer_out must be posted through consumeFIFO to enforce FIFO lot selection');
    expect(appendTransaction).not.toHaveBeenCalled();
  });

  it('throws when waste is passed directly — must go through consumeFIFO', async () => {
    await expect(
      postTransaction(
        {
          item_id: 'item-001',
          location_id: 'loc-001',
          qty_base: -5,
          txn_type: 'waste',
          ref_type: 'manual',
          ref_id: 'r-fifo-waste',
          unit_cost: 1.0,
        },
        stubSession
      )
    ).rejects.toThrow(
      'waste must be posted through consumeFIFO to enforce FIFO lot selection'
    );
    expect(appendTransaction).not.toHaveBeenCalled();
  });

  it('count_adjust with negative qty_base succeeds (bidirectional)', async () => {
    await expect(
      postTransaction(
        {
          item_id: 'item-001',
          location_id: 'loc-001',
          qty_base: -3,
          txn_type: 'count_adjust',
          ref_type: 'manual',
          ref_id: 'r-adj-neg',
          unit_cost: 1.0,
        },
        stubSession // director_admin
      )
    ).resolves.toBeDefined();
    expect(appendTransaction).toHaveBeenCalledOnce();
  });

  it('sanitizes note with leading space followed by formula character (M1)', async () => {
    await postTransaction(
      {
        item_id: 'item-001',
        location_id: 'loc-001',
        qty_base: 10,
        txn_type: 'receive',
        ref_type: 'receipt',
        ref_id: 'r-leading-space',
        unit_cost: 1.0,
        note: ' =CMD',
      },
      stubSession
    );

    const arg = vi.mocked(appendTransaction).mock.calls[0][0];
    expect(arg.note).toBe("' =CMD");
  });

  it('throws when receive txn_type has negative qty_base — sign violation (H2)', async () => {
    await expect(
      postTransaction(
        {
          item_id: 'item-001',
          location_id: 'loc-001',
          qty_base: -10,
          txn_type: 'receive',
          ref_type: 'receipt',
          ref_id: 'r-003',
          unit_cost: 1.0,
        },
        stubSession
      )
    ).rejects.toThrow('receive must have positive qty_base');
    expect(appendTransaction).not.toHaveBeenCalled();
  });

  it('throws when session does not have access to the location (H1)', async () => {
    const restrictedSession: Session = {
      userId: 'user-2',
      role: Role.kitchen_manager,
      assignedLocationIds: ['loc-999'],
    };

    await expect(
      postTransaction(
        {
          item_id: 'item-001',
          location_id: 'loc-001',
          qty_base: 10,
          txn_type: 'receive',
          ref_type: 'receipt',
          ref_id: 'r-004',
          unit_cost: 1.0,
        },
        restrictedSession
      )
    ).rejects.toThrow('Access denied');
    expect(appendTransaction).not.toHaveBeenCalled();
  });

  it('allows count_adjust for director_admin role', async () => {
    await expect(
      postTransaction(
        {
          item_id: 'item-001',
          location_id: 'loc-001',
          qty_base: 5,
          txn_type: 'count_adjust',
          ref_type: 'manual',
          ref_id: 'r-005',
          unit_cost: 1.0,
        },
        stubSession // director_admin
      )
    ).resolves.toBeDefined();
  });

  it('throws when kitchen_manager tries count_adjust (role gate H1)', async () => {
    const kitchenSession: Session = {
      userId: 'user-3',
      role: Role.kitchen_manager,
      assignedLocationIds: 'all',
    };

    await expect(
      postTransaction(
        {
          item_id: 'item-001',
          location_id: 'loc-001',
          qty_base: 5,
          txn_type: 'count_adjust',
          ref_type: 'manual',
          ref_id: 'r-006',
          unit_cost: 1.0,
        },
        kitchenSession
      )
    ).rejects.toThrow('Access denied');
    expect(appendTransaction).not.toHaveBeenCalled();
  });

  it('throws when kitchen_manager tries waste (role gate H1)', async () => {
    const kitchenSession: Session = {
      userId: 'user-3',
      role: Role.kitchen_manager,
      assignedLocationIds: 'all',
    };

    await expect(
      postTransaction(
        {
          item_id: 'item-001',
          location_id: 'loc-001',
          qty_base: -3,
          txn_type: 'waste',
          ref_type: 'manual',
          ref_id: 'r-007',
          unit_cost: 1.0,
        },
        kitchenSession
      )
    ).rejects.toThrow('Access denied');
    expect(appendTransaction).not.toHaveBeenCalled();
  });

  it('sanitizes formula-injection note (M1)', async () => {
    await postTransaction(
      {
        item_id: 'item-001',
        location_id: 'loc-001',
        qty_base: 10,
        txn_type: 'receive',
        ref_type: 'receipt',
        ref_id: 'r-008',
        unit_cost: 1.0,
        note: '+cmd|/bin/sh',
      },
      stubSession
    );

    const arg = vi.mocked(appendTransaction).mock.calls[0][0];
    expect(arg.note).toBe("'+cmd|/bin/sh");
  });
});

// ─── getLots ──────────────────────────────────────────────────────────────────

describe('getLots', () => {
  it('returns only lots for the specified item and location', async () => {
    vi.mocked(getAllLots).mockResolvedValue([
      makeLot({ lot_id: 'lot-1', item_id: 'item-001', location_id: 'loc-001', remaining_qty: 10 }),
      makeLot({ lot_id: 'lot-2', item_id: 'item-002', location_id: 'loc-001', remaining_qty: 10 }),
      makeLot({ lot_id: 'lot-3', item_id: 'item-001', location_id: 'loc-002', remaining_qty: 10 }),
    ]);

    const lots = await getLots('item-001', 'loc-001', stubSession);
    expect(lots).toHaveLength(1);
    expect(lots[0].lot_id).toBe('lot-1');
  });

  it('excludes lots with remaining_qty of 0', async () => {
    vi.mocked(getAllLots).mockResolvedValue([
      makeLot({ lot_id: 'lot-active', remaining_qty: 5 }),
      makeLot({ lot_id: 'lot-empty', remaining_qty: 0 }),
    ]);

    const lots = await getLots('item-001', 'loc-001', stubSession);
    expect(lots).toHaveLength(1);
    expect(lots[0].lot_id).toBe('lot-active');
  });

  it('returns lots sorted by received_date ascending (oldest first)', async () => {
    vi.mocked(getAllLots).mockResolvedValue([
      makeLot({ lot_id: 'lot-c', received_date: '2026-03-01', remaining_qty: 10 }),
      makeLot({ lot_id: 'lot-a', received_date: '2026-01-01', remaining_qty: 10 }),
      makeLot({ lot_id: 'lot-b', received_date: '2026-02-01', remaining_qty: 10 }),
    ]);

    const lots = await getLots('item-001', 'loc-001', stubSession);
    expect(lots.map((l) => l.lot_id)).toEqual(['lot-a', 'lot-b', 'lot-c']);
  });

  it('returns an empty array when no eligible lots exist', async () => {
    vi.mocked(getAllLots).mockResolvedValue([]);
    const lots = await getLots('item-001', 'loc-001', stubSession);
    expect(lots).toHaveLength(0);
  });

  it('throws when session does not have access to the location (H1)', async () => {
    const restrictedSession: Session = {
      userId: 'user-2',
      role: Role.kitchen_manager,
      assignedLocationIds: ['loc-999'],
    };
    vi.mocked(getAllLots).mockResolvedValue([]);
    await expect(
      getLots('item-001', 'loc-001', restrictedSession)
    ).rejects.toThrow('Access denied');
  });
});

// ─── getMovementHistory ───────────────────────────────────────────────────────

describe('getMovementHistory', () => {
  it('filters to the specified location and returns matching transactions', async () => {
    vi.mocked(getAllTransactions).mockResolvedValue([
      makeTxn({ txn_id: 't1', item_id: 'item-001', location_id: 'loc-001', timestamp: '2026-06-01T10:00:00Z' }),
      makeTxn({ txn_id: 't2', item_id: 'item-001', location_id: 'loc-002', timestamp: '2026-06-02T10:00:00Z' }),
      makeTxn({ txn_id: 't3', item_id: 'item-002', location_id: 'loc-001', timestamp: '2026-06-03T10:00:00Z' }),
    ]);

    const history = await getMovementHistory('item-001', 'loc-001', stubSession);
    expect(history).toHaveLength(1);
    expect(history[0].txn_id).toBe('t1');
  });

  it('filters to a specific location when locationId is provided', async () => {
    vi.mocked(getAllTransactions).mockResolvedValue([
      makeTxn({ txn_id: 't1', item_id: 'item-001', location_id: 'loc-001', timestamp: '2026-06-01T10:00:00Z' }),
      makeTxn({ txn_id: 't2', item_id: 'item-001', location_id: 'loc-002', timestamp: '2026-06-02T10:00:00Z' }),
    ]);

    const history = await getMovementHistory('item-001', 'loc-001', stubSession);
    expect(history).toHaveLength(1);
    expect(history[0].txn_id).toBe('t1');
  });

  it('returns transactions sorted by timestamp descending (newest first)', async () => {
    vi.mocked(getAllTransactions).mockResolvedValue([
      makeTxn({ txn_id: 't-early', item_id: 'item-001', location_id: 'loc-001', timestamp: '2026-01-01T00:00:00Z' }),
      makeTxn({ txn_id: 't-late',  item_id: 'item-001', location_id: 'loc-001', timestamp: '2026-06-01T00:00:00Z' }),
      makeTxn({ txn_id: 't-mid',   item_id: 'item-001', location_id: 'loc-001', timestamp: '2026-03-15T00:00:00Z' }),
    ]);

    const history = await getMovementHistory('item-001', 'loc-001', stubSession);
    expect(history.map((t) => t.txn_id)).toEqual(['t-late', 't-mid', 't-early']);
  });

  it('returns an empty array when there are no transactions for the item at the location', async () => {
    vi.mocked(getAllTransactions).mockResolvedValue([
      makeTxn({ txn_id: 't1', item_id: 'item-other', location_id: 'loc-001' }),
    ]);

    const history = await getMovementHistory('item-001', 'loc-001', stubSession);
    expect(history).toHaveLength(0);
  });

  it('throws when session does not have access to the location (H1)', async () => {
    const restrictedSession: Session = {
      userId: 'user-2',
      role: Role.kitchen_manager,
      assignedLocationIds: ['loc-999'],
    };
    vi.mocked(getAllTransactions).mockResolvedValue([]);
    await expect(
      getMovementHistory('item-001', 'loc-001', restrictedSession)
    ).rejects.toThrow('Access denied');
  });
});

// ─── getOnHand — canonical deduplication ─────────────────────────────────────

describe('getOnHand — uses canonical transactions', () => {
  it('uses getCanonicalTransactions to deduplicate duplicate rows', async () => {
    // Canonical returns one deduplicated transaction.
    vi.mocked(getCanonicalTransactions).mockResolvedValue([
      makeTxn({ txn_id: 't1', qty_base: 50 }),
    ]);
    // getAllTransactions would naively double-count if called.
    vi.mocked(getAllTransactions).mockResolvedValue([
      makeTxn({ txn_id: 't1', qty_base: 50 }),
      makeTxn({ txn_id: 't1', qty_base: 50 }), // duplicate
    ]);

    // getOnHand uses canonical transactions — result must be 50, not 100.
    const onHand = await getOnHand('item-001', 'loc-001', stubSession);
    expect(onHand).toBe(50);
  });
});

// ─── getInventoryValue — canonical lot deduplication ─────────────────────────

describe('getInventoryValue — uses canonical lots', () => {
  it('uses getCanonicalLots so duplicate physical rows do not double-count value', async () => {
    // Canonical collapses to one lot.
    vi.mocked(getCanonicalLots).mockResolvedValue([
      makeLot({ lot_id: 'lot-1', remaining_qty: 10, unit_cost: 3.0 }),
    ]);
    // getAllLots would double-count if called instead.
    vi.mocked(getAllLots).mockResolvedValue([
      makeLot({ lot_id: 'lot-1', remaining_qty: 10, unit_cost: 3.0 }),
      makeLot({ lot_id: 'lot-1', remaining_qty: 10, unit_cost: 3.0 }), // duplicate
    ]);

    const value = await getInventoryValue('loc-001', stubSession);
    // Must be 30 (10 × 3.0), not 60.
    expect(value).toBeCloseTo(30);
  });
});

// ─── reconcileLotBalance ──────────────────────────────────────────────────────

describe('reconcileLotBalance', () => {
  it('derives remaining from canonical transactions and calls setLotRemainingById', async () => {
    const lot = makeLot({
      lot_id: 'lot-1',
      original_qty: 100,
      remaining_qty: 99, // stale
      unit_cost: 2.0,
    });

    // Creation txn (+100) and one outflow (-30) → derived = 70.
    vi.mocked(getCanonicalTransactions).mockResolvedValue([
      makeTxn({ txn_id: 't-recv', lot_id: 'lot-1', qty_base: 100, txn_type: 'receive' }),
      makeTxn({ txn_id: 't-out', lot_id: 'lot-1', qty_base: -30, txn_type: 'consume' }),
    ]);

    const repaired = await reconcileLotBalance(lot);

    expect(setLotRemainingById).toHaveBeenCalledWith('lot-1', 70);
    expect(repaired.remaining_qty).toBe(70);
  });

  it('throws IntegrityConflictError when derived remaining is below zero', async () => {
    const { IntegrityConflictError: ICE } = await import('../../../lib/services/errors');
    const lot = makeLot({ lot_id: 'lot-1', original_qty: 100, remaining_qty: 5 });

    vi.mocked(getCanonicalTransactions).mockResolvedValue([
      makeTxn({ txn_id: 't-recv', lot_id: 'lot-1', qty_base: 100, txn_type: 'receive' }),
      makeTxn({ txn_id: 't-out', lot_id: 'lot-1', qty_base: -200, txn_type: 'consume' }),
    ]);

    await expect(reconcileLotBalance(lot)).rejects.toBeInstanceOf(ICE);
    expect(setLotRemainingById).not.toHaveBeenCalled();
  });

  it('throws IntegrityConflictError when derived remaining exceeds original_qty', async () => {
    const { IntegrityConflictError: ICE } = await import('../../../lib/services/errors');
    const lot = makeLot({ lot_id: 'lot-1', original_qty: 100, remaining_qty: 50 });

    vi.mocked(getCanonicalTransactions).mockResolvedValue([
      makeTxn({ txn_id: 't-recv', lot_id: 'lot-1', qty_base: 200, txn_type: 'receive' }),
    ]);

    await expect(reconcileLotBalance(lot)).rejects.toBeInstanceOf(ICE);
    expect(setLotRemainingById).not.toHaveBeenCalled();
  });

  it('throws IntegrityConflictError when there is no positive creation transaction for the lot', async () => {
    const { IntegrityConflictError: ICE } = await import('../../../lib/services/errors');
    const lot = makeLot({ lot_id: 'lot-1', original_qty: 100, remaining_qty: 50 });

    // Only outflows, no inflow.
    vi.mocked(getCanonicalTransactions).mockResolvedValue([
      makeTxn({ txn_id: 't-out', lot_id: 'lot-1', qty_base: -30, txn_type: 'consume' }),
    ]);

    await expect(reconcileLotBalance(lot)).rejects.toBeInstanceOf(ICE);
    expect(setLotRemainingById).not.toHaveBeenCalled();
  });
});

// ─── ensureInboundPortion ─────────────────────────────────────────────────────

describe('ensureInboundPortion', () => {
  const lot = makeLot({ lot_id: 'lot:recv:v1:abc', original_qty: 50, remaining_qty: 50 });
  const txnInput = {
    txn_id: 'txn:recv:v1:abc',
    item_id: 'item-001',
    location_id: 'loc-001',
    lot_id: 'lot:recv:v1:abc',
    qty_base: 50,
    txn_type: 'receive' as const,
    ref_type: 'receipt' as const,
    ref_id: 'rcpt-1',
    unit_cost: 2.0,
  };

  it('calls ensureLot, then ensureTransaction, then reconcileLotBalance', async () => {
    vi.mocked(ensureLot).mockResolvedValue({ value: lot, outcome: 'created' });
    vi.mocked(ensureTransaction).mockResolvedValue({
      value: { ...txnInput, timestamp: '2026-06-06T00:00:00Z', user_id: 'user-1' },
      outcome: 'created',
    });
    vi.mocked(getCanonicalTransactions).mockResolvedValue([
      makeTxn({ txn_id: 'txn:recv:v1:abc', lot_id: 'lot:recv:v1:abc', qty_base: 50, txn_type: 'receive' }),
    ]);

    const result = await ensureInboundPortion({ lot, transaction: txnInput, session: stubSession });

    expect(ensureLot).toHaveBeenCalledWith(lot);
    expect(ensureTransaction).toHaveBeenCalledOnce();
    expect(setLotRemainingById).toHaveBeenCalledWith('lot:recv:v1:abc', 50);
    expect(result.lot.lot_id).toBe('lot:recv:v1:abc');
  });

  it('is idempotent: when lot and transaction both exist, no new writes', async () => {
    vi.mocked(ensureLot).mockResolvedValue({ value: lot, outcome: 'existing' });
    vi.mocked(ensureTransaction).mockResolvedValue({
      value: { ...txnInput, timestamp: '2026-06-06T00:00:00Z', user_id: 'user-1' },
      outcome: 'existing',
    });
    vi.mocked(getCanonicalTransactions).mockResolvedValue([
      makeTxn({ txn_id: 'txn:recv:v1:abc', lot_id: 'lot:recv:v1:abc', qty_base: 50, txn_type: 'receive' }),
    ]);

    await ensureInboundPortion({ lot, transaction: txnInput, session: stubSession });

    // ensureLot and ensureTransaction were called but neither appended.
    expect(ensureLot).toHaveBeenCalledOnce();
    expect(ensureTransaction).toHaveBeenCalledOnce();
    // reconcileLotBalance still called to repair remaining_qty.
    expect(setLotRemainingById).toHaveBeenCalledOnce();
  });
});

// ─── reconcileFifoOutflow ─────────────────────────────────────────────────────

describe('reconcileFifoOutflow', () => {
  it('appends transfer_out transaction for oldest lot first', async () => {
    const oldLot = makeLot({
      lot_id: 'lot-old',
      received_date: '2026-01-01',
      remaining_qty: 30,
      unit_cost: 1.0,
    });
    const newLot = makeLot({
      lot_id: 'lot-new',
      received_date: '2026-03-01',
      remaining_qty: 20,
      unit_cost: 2.0,
    });

    // No existing outflows for this transfer.
    vi.mocked(getCanonicalTransactions).mockResolvedValue([
      makeTxn({ txn_id: 'recv-old', lot_id: 'lot-old', qty_base: 30, txn_type: 'receive' }),
      makeTxn({ txn_id: 'recv-new', lot_id: 'lot-new', qty_base: 20, txn_type: 'receive' }),
    ]);

    // ensureTransaction records the appended transaction.
    const appendedTxns: import('../../../lib/types').InventoryTransaction[] = [];
    vi.mocked(ensureTransaction).mockImplementation(async (txn) => {
      const full = { ...txn, timestamp: '2026-06-06T00:00:00Z', user_id: 'user-1' } as import('../../../lib/types').InventoryTransaction;
      appendedTxns.push(full);
      return { value: full, outcome: 'created' };
    });

    await reconcileFifoOutflow({
      transferId: 'xfer-001',
      itemId: 'item-001',
      requestedQtyBase: 35,
      sourceLots: [oldLot, newLot],
      session: stubSession,
      transactionIdForLot: (lotId) => `txn:xout:v1:${lotId}`,
    });

    // Two calls to ensureTransaction: one for old lot (30), one for new lot (5).
    expect(ensureTransaction).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(ensureTransaction).mock.calls;
    expect(calls[0][0].lot_id).toBe('lot-old');
    expect(calls[0][0].qty_base).toBe(-30);
    expect(calls[1][0].lot_id).toBe('lot-new');
    expect(calls[1][0].qty_base).toBe(-5);
  });

  it('throws when requestedQtyBase exceeds available stock', async () => {
    const { ValidationError: VE } = await import('../../../lib/services/errors');
    const lot = makeLot({ lot_id: 'lot-1', remaining_qty: 10, unit_cost: 1.0 });

    vi.mocked(getCanonicalTransactions).mockResolvedValue([
      makeTxn({ txn_id: 'recv-1', lot_id: 'lot-1', qty_base: 10, txn_type: 'receive' }),
    ]);

    await expect(
      reconcileFifoOutflow({
        transferId: 'xfer-001',
        itemId: 'item-001',
        requestedQtyBase: 50, // more than available
        sourceLots: [lot],
        session: stubSession,
        transactionIdForLot: (lotId) => `txn:xout:v1:${lotId}`,
      })
    ).rejects.toBeInstanceOf(VE);

    expect(ensureTransaction).not.toHaveBeenCalled();
  });

  it('is idempotent when all outflows already exist', async () => {
    const lot = makeLot({ lot_id: 'lot-1', remaining_qty: 0, unit_cost: 1.0, original_qty: 30 });

    // The outflow transaction already exists.
    vi.mocked(getCanonicalTransactions).mockResolvedValue([
      makeTxn({ txn_id: 'recv-1', lot_id: 'lot-1', qty_base: 30, txn_type: 'receive' }),
      makeTxn({
        txn_id: 'txn:xout:v1:lot-1',
        lot_id: 'lot-1',
        qty_base: -30,
        txn_type: 'transfer_out',
        ref_type: 'transfer',
        ref_id: 'xfer-001',
        unit_cost: 1.0,
      }),
    ]);

    vi.mocked(ensureTransaction).mockResolvedValue({
      value: makeTxn({
        txn_id: 'txn:xout:v1:lot-1',
        lot_id: 'lot-1',
        qty_base: -30,
        txn_type: 'transfer_out',
        ref_type: 'transfer',
        ref_id: 'xfer-001',
        unit_cost: 1.0,
      }),
      outcome: 'existing',
    });

    await reconcileFifoOutflow({
      transferId: 'xfer-001',
      itemId: 'item-001',
      requestedQtyBase: 30,
      sourceLots: [lot],
      session: stubSession,
      transactionIdForLot: (lotId) => `txn:xout:v1:${lotId}`,
    });

    // alreadyShipped (30) === requestedQtyBase (30) → early return, no new writes.
    expect(ensureTransaction).not.toHaveBeenCalled();
  });

  it('throws ValidationError when transactionIdForLot returns a blank ID', async () => {
    const { ValidationError: VE } = await import('../../../lib/services/errors');
    const lot = makeLot({ lot_id: 'lot-1', remaining_qty: 10, unit_cost: 1.0 });

    vi.mocked(getCanonicalTransactions).mockResolvedValue([
      makeTxn({ txn_id: 'recv-1', lot_id: 'lot-1', qty_base: 10, txn_type: 'receive' }),
    ]);

    await expect(
      reconcileFifoOutflow({
        transferId: 'xfer-001',
        itemId: 'item-001',
        requestedQtyBase: 5,
        sourceLots: [lot],
        session: stubSession,
        transactionIdForLot: () => '   ', // blank — non-deterministic guard
      })
    ).rejects.toBeInstanceOf(VE);
  });
});
