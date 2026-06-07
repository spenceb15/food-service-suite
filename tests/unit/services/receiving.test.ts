/**
 * Unit tests for lib/services/receiving.ts
 *
 * All Google Sheets I/O is mocked via vi.mock.  No real network calls are made.
 *
 * Coverage targets (original):
 *  - Happy path: single line → receipt, lot, transaction created with correct fields
 *  - Multi-line: two lines → one receipt, two lots, two transactions
 *  - Blind receive: no orderId → receipt.order_id is undefined/empty
 *  - Validation — empty lines: throws before any writes
 *  - Validation — qty <= 0: throws before any writes
 *  - Validation — negative unitCost: throws before any writes
 *  - Validation — empty itemId: throws before any writes
 *  - Validation — empty locationId: throws before any writes
 *  - Access denied: restricted session not covering target location
 *  - Correct lot fields (received_date = today, source_ref = receipt_id, etc.)
 *  - Correct transaction fields (txn_type='receive', positive qty, ref_type='receipt')
 *  - postTransaction called with session (not a hardcoded user_id)
 *
 * Coverage targets (Task 7 — retry-safe manifest reconciliation):
 *  - receiptId must match ^rcpt:v1:[0-9a-fA-F-]{36}$
 *  - Interrupted receipt: retry after header written converges to 1 receipt / 1 line / 1 lot / 1 txn
 *  - Changed payload under same receiptId → IdempotencyConflictError before any inventory writes
 *  - Added lines under same receiptId → IdempotencyConflictError
 *  - Route returns 201 for new receipt, 200 for retry/reconciliation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Role } from '../../../lib/types';
import type { Session, Receipt, ReceiptLine, Lot, InventoryTransaction } from '../../../lib/types';

// ─── Mocks ────────────────────────────────────────────────────────────────────
// vi.mock calls are hoisted to the top of the file by Vitest.

vi.mock('../../../lib/data/receipts', () => ({
  createReceipt: vi.fn(),
  createReceiptLine: vi.fn(),
  ensureReceipt: vi.fn(),
  ensureReceiptLine: vi.fn(),
  getReceiptLines: vi.fn(),
}));

vi.mock('../../../lib/data/lots', () => ({
  createLot: vi.fn(),
  // getAllLots and updateLot are used by inventory service; we mock the whole
  // module so inventory.ts can be imported without real I/O.
  getAllLots: vi.fn(),
  updateLot: vi.fn(),
  getCanonicalLots: vi.fn(),
  setLotRemainingById: vi.fn(),
  ensureLot: vi.fn(),
}));

vi.mock('../../../lib/services/inventory', () => ({
  postTransaction: vi.fn(),
  ensureInboundPortion: vi.fn(),
  getOnHand: vi.fn(),
  getInventoryValue: vi.fn(),
  consumeFIFO: vi.fn(),
  getLots: vi.fn(),
  getMovementHistory: vi.fn(),
  reconcileLotBalance: vi.fn(),
  reconcileFifoOutflow: vi.fn(),
}));

// Import mocked modules so we can set return values per test.
import { createReceipt, createReceiptLine, ensureReceipt, ensureReceiptLine, getReceiptLines } from '../../../lib/data/receipts';
import { createLot } from '../../../lib/data/lots';
import { postTransaction, ensureInboundPortion } from '../../../lib/services/inventory';

// Import the service under test AFTER mocks are wired.
import { receiveDelivery, receiveManifest } from '../../../lib/services/receiving';

// ─── Stub session ─────────────────────────────────────────────────────────────

const stubSession: Session = {
  userId: 'user-1',
  role: Role.director_admin,
  assignedLocationIds: 'all',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    receipt_id: 'receipt-001',
    order_id: 'order-001',
    source: 'vendor-001',
    location_id: 'loc-001',
    receipt_date: '2026-06-06',
    received_by: 'user-1',
    ...overrides,
  };
}

function makeLot(overrides: Partial<Lot> = {}): Lot {
  return {
    lot_id: 'lot-001',
    item_id: 'item-001',
    location_id: 'loc-001',
    received_date: '2026-06-06',
    original_qty: 10,
    remaining_qty: 10,
    unit_cost: 2.5,
    source_ref: 'receipt-001',
    ...overrides,
  };
}

function makeTransaction(overrides: Partial<InventoryTransaction> = {}): InventoryTransaction {
  return {
    txn_id: 'txn-001',
    timestamp: '2026-06-06T00:00:00Z',
    item_id: 'item-001',
    location_id: 'loc-001',
    lot_id: 'lot-001',
    qty_base: 10,
    txn_type: 'receive',
    ref_type: 'receipt',
    ref_id: 'receipt-001',
    unit_cost: 2.5,
    user_id: 'user-1',
    ...overrides,
  };
}

// A valid deterministic receiptId (UUID v4-shaped).
const VALID_RECEIPT_ID = 'rcpt:v1:550e8400-e29b-41d4-a716-446655440000';

beforeEach(() => {
  vi.clearAllMocks();

  // Default happy-path return values.
  vi.mocked(createReceipt).mockResolvedValue(makeReceipt());
  vi.mocked(createReceiptLine).mockResolvedValue({
    line_id: 'line-001',
    receipt_id: 'receipt-001',
    item_id: 'item-001',
    qty_received: 10,
    unit: 'each',
    unit_cost: 2.5,
  } as ReceiptLine);
  vi.mocked(createLot).mockResolvedValue(makeLot());
  vi.mocked(postTransaction).mockResolvedValue(makeTransaction());

  // Deterministic path defaults.
  vi.mocked(ensureReceipt).mockResolvedValue({ value: makeReceipt(), outcome: 'created' });
  vi.mocked(ensureReceiptLine).mockResolvedValue({
    value: { line_id: 'line-001', receipt_id: 'receipt-001', item_id: 'item-001', qty_received: 10, unit: 'each', unit_cost: 2.5 } as ReceiptLine,
    outcome: 'created',
  });
  vi.mocked(getReceiptLines).mockResolvedValue([]);
  vi.mocked(ensureInboundPortion).mockResolvedValue({
    lot: makeLot(),
    transaction: makeTransaction(),
  });
});

// ─── Happy path — single line ─────────────────────────────────────────────────

describe('receiveDelivery — single line (happy path)', () => {
  it('creates one receipt, one lot, posts one transaction and returns the receipt', async () => {
    const result = await receiveDelivery(
      {
        orderId: 'order-001',
        source: 'vendor-001',
        locationId: 'loc-001',
        lines: [
          { itemId: 'item-001', qtyReceived: 10, unit: 'each', unitCost: 2.5 },
        ],
      },
      stubSession
    );

    // Receipt header created exactly once.
    expect(createReceipt).toHaveBeenCalledOnce();

    // ReceiptLine created exactly once.
    expect(createReceiptLine).toHaveBeenCalledOnce();

    // Lot created exactly once.
    expect(createLot).toHaveBeenCalledOnce();

    // Transaction posted exactly once.
    expect(postTransaction).toHaveBeenCalledOnce();

    // Return value is the Receipt.
    expect(result.receipt_id).toBe('receipt-001');
  });

  it('passes the correct fields to createReceipt', async () => {
    const spoofedInput = {
      orderId: 'order-abc',
      source: 'vendor-xyz',
      locationId: 'loc-warehouse',
      receivedBy: 'spoofed-user',
      lines: [
        { itemId: 'item-001', qtyReceived: 5, unit: 'lb', unitCost: 1.0 },
      ],
    } as unknown as Parameters<typeof receiveDelivery>[0];

    await receiveDelivery(
      spoofedInput,
      stubSession
    );

    const receiptArg = vi.mocked(createReceipt).mock.calls[0][0];
    expect(receiptArg.order_id).toBe('order-abc');
    expect(receiptArg.source).toBe('vendor-xyz');
    expect(receiptArg.location_id).toBe('loc-warehouse');
    expect(receiptArg.received_by).toBe(stubSession.userId);
    // receipt_date should be today in YYYY-MM-DD format.
    expect(receiptArg.receipt_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('posts a receive transaction with correct fields', async () => {
    vi.mocked(createReceipt).mockResolvedValue(makeReceipt({ receipt_id: 'rcpt-99' }));
    vi.mocked(createLot).mockResolvedValue(makeLot({ lot_id: 'lot-99' }));

    await receiveDelivery(
      {
        source: 'vendor-001',
        locationId: 'loc-001',
        lines: [
          { itemId: 'item-001', qtyReceived: 20, unit: 'each', unitCost: 3.0 },
        ],
      },
      stubSession
    );

    const txnArg = vi.mocked(postTransaction).mock.calls[0][0];
    expect(txnArg.txn_type).toBe('receive');
    expect(txnArg.ref_type).toBe('receipt');
    expect(txnArg.ref_id).toBe('rcpt-99');
    expect(txnArg.lot_id).toBe('lot-99');
    expect(txnArg.qty_base).toBe(20);           // positive (inflow)
    expect(txnArg.item_id).toBe('item-001');
    expect(txnArg.location_id).toBe('loc-001');
    expect(txnArg.unit_cost).toBe(3.0);
  });

  it('creates a lot with correct FIFO fields', async () => {
    vi.mocked(createReceipt).mockResolvedValue(makeReceipt({ receipt_id: 'rcpt-lot-test' }));

    await receiveDelivery(
      {
        source: 'vendor-001',
        locationId: 'loc-001',
        lines: [
          {
            itemId: 'item-002',
            qtyReceived: 50,
            unit: 'oz',
            unitCost: 0.5,
            expirationDate: '2026-12-31',
          },
        ],
      },
      stubSession
    );

    const lotArg = vi.mocked(createLot).mock.calls[0][0];
    expect(lotArg.item_id).toBe('item-002');
    expect(lotArg.location_id).toBe('loc-001');
    expect(lotArg.original_qty).toBe(50);
    expect(lotArg.remaining_qty).toBe(50);       // nothing consumed yet
    expect(lotArg.unit_cost).toBe(0.5);
    expect(lotArg.expiration_date).toBe('2026-12-31');
    expect(lotArg.source_ref).toBe('rcpt-lot-test');
    // received_date must be today's ISO date.
    expect(lotArg.received_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('passes session through to postTransaction (not a hardcoded user)', async () => {
    const specificSession: Session = {
      userId: 'specific-user-id',
      role: Role.warehouse,
      assignedLocationIds: 'all',
    };

    await receiveDelivery(
      {
        source: 'vendor-001',
        locationId: 'loc-001',
        lines: [
          { itemId: 'item-001', qtyReceived: 5, unit: 'each', unitCost: 1.0 },
        ],
      },
      specificSession
    );

    // The second argument to postTransaction should be the session itself.
    const sessionArg = vi.mocked(postTransaction).mock.calls[0][1];
    expect(sessionArg.userId).toBe('specific-user-id');
    expect(sessionArg.role).toBe(Role.warehouse);
  });
});

// ─── Multi-line ───────────────────────────────────────────────────────────────

describe('receiveDelivery — multi-line', () => {
  it('creates one receipt, two lots, two transactions for two lines', async () => {
    vi.mocked(createReceipt).mockResolvedValue(makeReceipt({ receipt_id: 'rcpt-multi' }));
    vi.mocked(createLot)
      .mockResolvedValueOnce(makeLot({ lot_id: 'lot-A', item_id: 'item-001' }))
      .mockResolvedValueOnce(makeLot({ lot_id: 'lot-B', item_id: 'item-002' }));

    await receiveDelivery(
      {
        source: 'vendor-001',
        locationId: 'loc-001',
        lines: [
          { itemId: 'item-001', qtyReceived: 10, unit: 'each', unitCost: 1.0 },
          { itemId: 'item-002', qtyReceived: 20, unit: 'lb', unitCost: 2.0 },
        ],
      },
      stubSession
    );

    // One receipt header.
    expect(createReceipt).toHaveBeenCalledOnce();

    // Two receipt lines.
    expect(createReceiptLine).toHaveBeenCalledTimes(2);

    // Two lots (one per line).
    expect(createLot).toHaveBeenCalledTimes(2);

    // Two transactions (one per line).
    expect(postTransaction).toHaveBeenCalledTimes(2);

    // Each transaction references the shared receipt id.
    const [txn1, txn2] = vi.mocked(postTransaction).mock.calls;
    expect(txn1[0].ref_id).toBe('rcpt-multi');
    expect(txn2[0].ref_id).toBe('rcpt-multi');

    // Lots are distinct.
    const [lot1, lot2] = vi.mocked(createLot).mock.calls;
    expect(lot1[0].item_id).toBe('item-001');
    expect(lot2[0].item_id).toBe('item-002');
  });
});

// ─── Blind receive (no orderId) ───────────────────────────────────────────────

describe('receiveDelivery — blind receive', () => {
  it('creates a receipt with no order_id when orderId is omitted', async () => {
    await receiveDelivery(
      {
        // orderId intentionally absent
        source: 'vendor-blind',
        locationId: 'loc-001',
        lines: [
          { itemId: 'item-001', qtyReceived: 5, unit: 'each', unitCost: 1.0 },
        ],
      },
      stubSession
    );

    const receiptArg = vi.mocked(createReceipt).mock.calls[0][0];
    // order_id should be undefined (not provided) — the data layer stores '' in Sheets
    // but the service layer passes through undefined.
    expect(receiptArg.order_id).toBeUndefined();
  });
});

// ─── Validation — throws before any writes ────────────────────────────────────

describe('receiveDelivery — validation', () => {
  it('throws and makes no writes when lines array is empty', async () => {
    await expect(
      receiveDelivery(
        {
          source: 'vendor-001',
          locationId: 'loc-001',
          lines: [],
        },
        stubSession
      )
    ).rejects.toThrow('lines must be non-empty');

    expect(createReceipt).not.toHaveBeenCalled();
    expect(createLot).not.toHaveBeenCalled();
    expect(postTransaction).not.toHaveBeenCalled();
  });

  it('throws and makes no writes when a line has qty <= 0 (zero)', async () => {
    await expect(
      receiveDelivery(
        {
          source: 'vendor-001',
          locationId: 'loc-001',
          lines: [
            { itemId: 'item-001', qtyReceived: 0, unit: 'each', unitCost: 1.0 },
          ],
        },
        stubSession
      )
    ).rejects.toThrow('qtyReceived must be a positive number');

    expect(createReceipt).not.toHaveBeenCalled();
    expect(createLot).not.toHaveBeenCalled();
    expect(postTransaction).not.toHaveBeenCalled();
  });

  it('throws and makes no writes when a line has negative qty', async () => {
    await expect(
      receiveDelivery(
        {
          source: 'vendor-001',
          locationId: 'loc-001',
          lines: [
            { itemId: 'item-001', qtyReceived: -5, unit: 'each', unitCost: 1.0 },
          ],
        },
        stubSession
      )
    ).rejects.toThrow('qtyReceived must be a positive number');

    expect(createReceipt).not.toHaveBeenCalled();
    expect(createLot).not.toHaveBeenCalled();
    expect(postTransaction).not.toHaveBeenCalled();
  });

  it('throws and makes no writes when a line has NaN qty', async () => {
    await expect(
      receiveDelivery(
        {
          source: 'vendor-001',
          locationId: 'loc-001',
          lines: [
            { itemId: 'item-001', qtyReceived: NaN, unit: 'each', unitCost: 1.0 },
          ],
        },
        stubSession
      )
    ).rejects.toThrow('qtyReceived must be a positive number');

    expect(createReceipt).not.toHaveBeenCalled();
    expect(createLot).not.toHaveBeenCalled();
    expect(postTransaction).not.toHaveBeenCalled();
  });

  it('throws and makes no writes when a line has negative unitCost', async () => {
    await expect(
      receiveDelivery(
        {
          source: 'vendor-001',
          locationId: 'loc-001',
          lines: [
            { itemId: 'item-001', qtyReceived: 10, unit: 'each', unitCost: -1.0 },
          ],
        },
        stubSession
      )
    ).rejects.toThrow('unitCost must be a non-negative number');

    expect(createReceipt).not.toHaveBeenCalled();
    expect(createLot).not.toHaveBeenCalled();
    expect(postTransaction).not.toHaveBeenCalled();
  });

  it('allows unitCost of zero (free/donated goods)', async () => {
    await expect(
      receiveDelivery(
        {
          source: 'usda-commodity',
          locationId: 'loc-001',
          lines: [
            { itemId: 'item-001', qtyReceived: 10, unit: 'each', unitCost: 0 },
          ],
        },
        stubSession
      )
    ).resolves.toBeDefined();

    expect(createReceipt).toHaveBeenCalledOnce();
  });

  it('throws and makes no writes when a line has an empty itemId', async () => {
    await expect(
      receiveDelivery(
        {
          source: 'vendor-001',
          locationId: 'loc-001',
          lines: [
            { itemId: '', qtyReceived: 10, unit: 'each', unitCost: 1.0 },
          ],
        },
        stubSession
      )
    ).rejects.toThrow('each line must have a non-empty itemId');

    expect(createReceipt).not.toHaveBeenCalled();
    expect(createLot).not.toHaveBeenCalled();
    expect(postTransaction).not.toHaveBeenCalled();
  });

  it('throws and makes no writes when a line has a whitespace-only itemId', async () => {
    await expect(
      receiveDelivery(
        {
          source: 'vendor-001',
          locationId: 'loc-001',
          lines: [
            { itemId: '   ', qtyReceived: 10, unit: 'each', unitCost: 1.0 },
          ],
        },
        stubSession
      )
    ).rejects.toThrow('each line must have a non-empty itemId');

    expect(createReceipt).not.toHaveBeenCalled();
    expect(createLot).not.toHaveBeenCalled();
    expect(postTransaction).not.toHaveBeenCalled();
  });

  it('throws and makes no writes when locationId is empty', async () => {
    await expect(
      receiveDelivery(
        {
          source: 'vendor-001',
          locationId: '',
          lines: [
            { itemId: 'item-001', qtyReceived: 10, unit: 'each', unitCost: 1.0 },
          ],
        },
        stubSession
      )
    ).rejects.toThrow('locationId must be non-empty');

    expect(createReceipt).not.toHaveBeenCalled();
    expect(createLot).not.toHaveBeenCalled();
    expect(postTransaction).not.toHaveBeenCalled();
  });

  it('throws when source is empty', async () => {
    await expect(
      receiveDelivery(
        {
          source: '',
          locationId: 'loc-001',
          lines: [
            { itemId: 'item-001', qtyReceived: 10, unit: 'each', unitCost: 1.0 },
          ],
        },
        stubSession
      )
    ).rejects.toThrow('source must be a non-empty string');

    expect(createReceipt).not.toHaveBeenCalled();
  });

  it('throws when source exceeds 200 characters', async () => {
    await expect(
      receiveDelivery(
        {
          source: 'v'.repeat(201),
          locationId: 'loc-001',
          lines: [
            { itemId: 'item-001', qtyReceived: 10, unit: 'each', unitCost: 1.0 },
          ],
        },
        stubSession
      )
    ).rejects.toThrow('source exceeds max length');

    expect(createReceipt).not.toHaveBeenCalled();
  });

  it('throws when expirationDate has an invalid format (slash-delimited)', async () => {
    await expect(
      receiveDelivery(
        {
          source: 'vendor-001',
          locationId: 'loc-001',
          lines: [
            {
              itemId: 'item-001',
              qtyReceived: 10,
              unit: 'each',
              unitCost: 1.0,
              expirationDate: '2024/01/15',
            },
          ],
        },
        stubSession
      )
    ).rejects.toThrow('expirationDate must be ISO date (YYYY-MM-DD)');

    expect(createReceipt).not.toHaveBeenCalled();
  });

  it('passes validation when expirationDate is a valid ISO date', async () => {
    await expect(
      receiveDelivery(
        {
          source: 'vendor-001',
          locationId: 'loc-001',
          lines: [
            {
              itemId: 'item-001',
              qtyReceived: 10,
              unit: 'each',
              unitCost: 1.0,
              expirationDate: '2024-01-15',
            },
          ],
        },
        stubSession
      )
    ).resolves.toBeDefined();

    expect(createReceipt).toHaveBeenCalledOnce();
  });
});

// ─── Access control ───────────────────────────────────────────────────────────

describe('receiveDelivery — access control', () => {
  it('throws Access denied and makes no writes when session excludes the target location', async () => {
    const restrictedSession: Session = {
      userId: 'user-2',
      role: Role.kitchen_manager,
      assignedLocationIds: ['loc-999', 'loc-888'],   // does NOT include loc-001
    };

    await expect(
      receiveDelivery(
        {
          source: 'vendor-001',
          locationId: 'loc-001',
          lines: [
            { itemId: 'item-001', qtyReceived: 10, unit: 'each', unitCost: 1.0 },
          ],
        },
        restrictedSession
      )
    ).rejects.toThrow('Access denied');

    // No writes must occur — access check runs before createReceipt.
    expect(createReceipt).not.toHaveBeenCalled();
    expect(createLot).not.toHaveBeenCalled();
    expect(postTransaction).not.toHaveBeenCalled();
  });

  it('succeeds when session.assignedLocationIds is the string "all"', async () => {
    const allAccessSession: Session = {
      userId: 'director',
      role: Role.director_admin,
      assignedLocationIds: 'all',
    };

    await expect(
      receiveDelivery(
        {
          source: 'vendor-001',
          locationId: 'loc-any',
          lines: [
            { itemId: 'item-001', qtyReceived: 1, unit: 'each', unitCost: 1.0 },
          ],
        },
        allAccessSession
      )
    ).resolves.toBeDefined();

    expect(createReceipt).toHaveBeenCalledOnce();
  });

  it('succeeds when session.assignedLocationIds includes the target location', async () => {
    const scopedSession: Session = {
      userId: 'kitchen-mgr',
      role: Role.kitchen_manager,
      assignedLocationIds: ['loc-001', 'loc-002'],
    };

    await expect(
      receiveDelivery(
        {
          source: 'vendor-001',
          locationId: 'loc-001',
          lines: [
            { itemId: 'item-001', qtyReceived: 5, unit: 'each', unitCost: 2.0 },
          ],
        },
        scopedSession
      )
    ).resolves.toBeDefined();

    expect(createReceipt).toHaveBeenCalledOnce();
  });
});

// ─── Task 7: receiveManifest — retry-safe receipt reconciliation ──────────────

describe('receiveManifest — input contract', () => {
  const validLines = [
    { itemId: 'item-001', qtyReceived: 10, unit: 'each', unitCost: 2.5 },
  ];

  it('throws ValidationError when receiptId is missing', async () => {
    const { ValidationError: VE } = await import('../../../lib/services/errors');
    await expect(
      receiveManifest(
        { receiptId: '', source: 'vendor-1', locationId: 'loc-1', lines: validLines },
        stubSession
      )
    ).rejects.toBeInstanceOf(VE);
    expect(ensureReceipt).not.toHaveBeenCalled();
  });

  it('throws ValidationError when receiptId does not match expected pattern', async () => {
    const { ValidationError: VE } = await import('../../../lib/services/errors');
    await expect(
      receiveManifest(
        { receiptId: 'random-id', source: 'vendor-1', locationId: 'loc-1', lines: validLines },
        stubSession
      )
    ).rejects.toBeInstanceOf(VE);
    expect(ensureReceipt).not.toHaveBeenCalled();
  });

  it('accepts a well-formed receiptId and proceeds', async () => {
    await expect(
      receiveManifest(
        { receiptId: VALID_RECEIPT_ID, source: 'vendor-1', locationId: 'loc-1', lines: validLines },
        stubSession
      )
    ).resolves.toBeDefined();
    expect(ensureReceipt).toHaveBeenCalledOnce();
  });
});

describe('receiveManifest — interrupted receipt retry', () => {
  it('converges to 1 receipt / 1 line / 1 lot+txn on retry after header written', async () => {
    // First call already wrote the header; second call retries.
    vi.mocked(ensureReceipt).mockResolvedValue({
      value: makeReceipt({ receipt_id: VALID_RECEIPT_ID }),
      outcome: 'existing',
    });
    // No existing lines yet.
    vi.mocked(getReceiptLines).mockResolvedValue([]);
    vi.mocked(ensureReceiptLine).mockResolvedValue({
      value: { line_id: 'rline:v1:abc', receipt_id: VALID_RECEIPT_ID, item_id: 'item-001', qty_received: 10, unit: 'each', unit_cost: 2.5 } as ReceiptLine,
      outcome: 'created',
    });
    vi.mocked(ensureInboundPortion).mockResolvedValue({
      lot: makeLot(),
      transaction: makeTransaction(),
    });

    const result = await receiveManifest(
      {
        receiptId: VALID_RECEIPT_ID,
        source: 'vendor-1',
        locationId: 'loc-1',
        lines: [{ itemId: 'item-001', qtyReceived: 10, unit: 'each', unitCost: 2.5 }],
      },
      stubSession
    );

    expect(ensureReceipt).toHaveBeenCalledOnce();
    expect(ensureReceiptLine).toHaveBeenCalledOnce();
    expect(ensureInboundPortion).toHaveBeenCalledOnce();
    expect(result.outcome).toBe('existing');
  });
});

describe('receiveManifest — changed payload rejection', () => {
  it('throws IdempotencyConflictError when an unexpected extra line exists under the same receiptId', async () => {
    const { IdempotencyConflictError: ICE } = await import('../../../lib/services/errors');

    vi.mocked(ensureReceipt).mockResolvedValue({
      value: makeReceipt({ receipt_id: VALID_RECEIPT_ID }),
      outcome: 'existing',
    });
    // Extra line in the store that is NOT in the expected manifest.
    vi.mocked(getReceiptLines).mockResolvedValue([
      { line_id: 'rline:v1:unexpected', receipt_id: VALID_RECEIPT_ID, item_id: 'item-999', qty_received: 5, unit: 'each', unit_cost: 1.0 },
    ]);

    await expect(
      receiveManifest(
        {
          receiptId: VALID_RECEIPT_ID,
          source: 'vendor-1',
          locationId: 'loc-1',
          lines: [{ itemId: 'item-001', qtyReceived: 10, unit: 'each', unitCost: 2.5 }],
        },
        stubSession
      )
    ).rejects.toBeInstanceOf(ICE);

    // No inventory writes must occur.
    expect(ensureInboundPortion).not.toHaveBeenCalled();
  });
});

describe('receiveManifest — outcome signalling', () => {
  it('returns outcome=created when the receipt header was newly created', async () => {
    vi.mocked(ensureReceipt).mockResolvedValue({
      value: makeReceipt({ receipt_id: VALID_RECEIPT_ID }),
      outcome: 'created',
    });
    vi.mocked(getReceiptLines).mockResolvedValue([]);

    const result = await receiveManifest(
      {
        receiptId: VALID_RECEIPT_ID,
        source: 'vendor-1',
        locationId: 'loc-1',
        lines: [{ itemId: 'item-001', qtyReceived: 10, unit: 'each', unitCost: 2.5 }],
      },
      stubSession
    );

    expect(result.outcome).toBe('created');
  });

  it('returns outcome=existing when the receipt header already existed', async () => {
    vi.mocked(ensureReceipt).mockResolvedValue({
      value: makeReceipt({ receipt_id: VALID_RECEIPT_ID }),
      outcome: 'existing',
    });
    vi.mocked(getReceiptLines).mockResolvedValue([]);

    const result = await receiveManifest(
      {
        receiptId: VALID_RECEIPT_ID,
        source: 'vendor-1',
        locationId: 'loc-1',
        lines: [{ itemId: 'item-001', qtyReceived: 10, unit: 'each', unitCost: 2.5 }],
      },
      stubSession
    );

    expect(result.outcome).toBe('existing');
  });
});
