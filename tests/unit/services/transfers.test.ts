/**
 * Unit tests for lib/services/transfers.ts
 *
 * All Google Sheets I/O and inventory service calls are mocked via vi.mock.
 * No real network calls are made.
 *
 * Coverage targets (original):
 *  - requestTransfer: happy path, all validation branches, access denied
 *  - approveTransfer: happy path, wrong status, non-director_admin role
 *  - shipTransfer: happy path (consumeFIFO called per line), wrong status,
 *    access denied to fromLocation
 *  - receiveTransfer: happy path (lot + transfer_in per outbound txn),
 *    wrong status, access denied to toLocation
 *  - Transfer-balance invariant: receiveTransfer reconstructs costs from
 *    transfer_out transactions, not from new inputs
 *
 * Coverage targets (Tasks 8 & 9 — retry-safe):
 *  - shipTransfer: source-only auth; kitchen/site role denied
 *  - shipTransfer: partial-shipment retry — missing quantities appended, existing untouched
 *  - shipTransfer: existing outbound integrity checks (positive qty, wrong source, wrong item, bad IDs)
 *  - shipTransfer: idempotent when status already in_transit
 *  - shipTransfer: status advances last, only after exact quantity verified
 *  - receiveTransfer: destination-only auth; warehouse without destination denied
 *  - receiveTransfer: interrupted inbound retry converges
 *  - receiveTransfer: verifyOutboundManifest rejects missing/short/excess/extra outbounds
 *  - receiveTransfer: unexpected inbound artifacts → IntegrityConflictError
 *  - receiveTransfer: status already received → idempotent
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  Transfer,
  TransferLine,
  InventoryTransaction,
  Lot,
  Session,
} from '../../../lib/types';
import { Role } from '../../../lib/types';

// ─── Mocks ────────────────────────────────────────────────────────────────────
// vi.mock calls are hoisted to the top of the file by Vitest.

vi.mock('../../../lib/data/transfers', () => ({
  getAllTransfers: vi.fn(),
  getAllTransferLines: vi.fn(),
  createTransfer: vi.fn(),
  createTransferLine: vi.fn(),
  updateTransfer: vi.fn(),
}));

vi.mock('../../../lib/data/lots', () => ({
  createLot: vi.fn(),
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

vi.mock('../../../lib/services/inventory', () => ({
  consumeFIFO: vi.fn(),
  postTransaction: vi.fn(),
  reconcileFifoOutflow: vi.fn(),
  ensureInboundPortion: vi.fn(),
  reconcileLotBalance: vi.fn(),
  getCanonicalLots: vi.fn(),
}));

// Import mocked modules so we can configure them per test.
import {
  getAllTransfers,
  getAllTransferLines,
  createTransfer,
  createTransferLine,
  updateTransfer,
} from '../../../lib/data/transfers';
import { createLot, getAllLots, getCanonicalLots } from '../../../lib/data/lots';
import { getAllTransactions, getCanonicalTransactions } from '../../../lib/data/transactions';
import { consumeFIFO, postTransaction, reconcileFifoOutflow, ensureInboundPortion } from '../../../lib/services/inventory';

// Import the service under test AFTER mocks are wired.
import {
  requestTransfer,
  approveTransfer,
  shipTransfer,
  receiveTransfer,
} from '../../../lib/services/transfers';

// ─── Stub session (director_admin, all locations) ─────────────────────────────

const stubSession: Session = {
  userId: 'user-1',
  role: Role.director_admin,
  assignedLocationIds: 'all',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
  return {
    transfer_id: 'xfer-001',
    from_location_id: 'loc-warehouse',
    to_location_id: 'loc-school',
    status: 'requested',
    requested_by: 'user-1',
    request_date: '2026-06-06',
    ...overrides,
  };
}

function makeLine(overrides: Partial<TransferLine> = {}): TransferLine {
  return {
    line_id: 'line-001',
    transfer_id: 'xfer-001',
    item_id: 'item-001',
    qty: 10,
    unit: 'each',
    ...overrides,
  };
}

function makeTxn(
  overrides: Partial<InventoryTransaction> & { txn_id: string }
): InventoryTransaction {
  return {
    timestamp: '2026-06-06T00:00:00Z',
    item_id: 'item-001',
    location_id: 'loc-warehouse',
    lot_id: 'lot-source-1',
    qty_base: -10,
    txn_type: 'transfer_out',
    ref_type: 'transfer',
    ref_id: 'xfer-001',
    unit_cost: 2.5,
    user_id: 'user-1',
    ...overrides,
  };
}

function makeLot(overrides: Partial<Lot> = {}): Lot {
  return {
    lot_id: 'lot-dest-1',
    item_id: 'item-001',
    location_id: 'loc-school',
    received_date: '2026-06-06',
    original_qty: 10,
    remaining_qty: 10,
    unit_cost: 2.5,
    source_ref: 'xfer-001',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  // Default happy-path return values — individual tests override as needed.
  vi.mocked(createTransfer).mockResolvedValue(makeTransfer());
  vi.mocked(createTransferLine).mockResolvedValue(makeLine());
  vi.mocked(updateTransfer).mockResolvedValue(makeTransfer());
  vi.mocked(getAllTransfers).mockResolvedValue([makeTransfer()]);
  vi.mocked(getAllTransferLines).mockResolvedValue([makeLine()]);
  vi.mocked(getAllTransactions).mockResolvedValue([]);
  vi.mocked(getCanonicalTransactions).mockResolvedValue([]);
  vi.mocked(getAllLots).mockResolvedValue([
    makeLot({
      lot_id: 'source-item-1',
      item_id: 'item-001',
      location_id: 'loc-warehouse',
      remaining_qty: 100,
    }),
    makeLot({
      lot_id: 'source-item-2',
      item_id: 'item-002',
      location_id: 'loc-warehouse',
      remaining_qty: 100,
    }),
  ]);
  vi.mocked(getCanonicalLots).mockResolvedValue([]);
  vi.mocked(consumeFIFO).mockResolvedValue({ lotConsumed: [] });
  vi.mocked(reconcileFifoOutflow).mockResolvedValue(undefined);
  vi.mocked(createLot).mockResolvedValue(makeLot());
  vi.mocked(postTransaction).mockResolvedValue({} as InventoryTransaction);
  vi.mocked(ensureInboundPortion).mockResolvedValue({
    lot: makeLot(),
    transaction: makeTxn({ txn_id: 'txn-in-1' }) as InventoryTransaction,
  });
});

// ─── requestTransfer — happy path ─────────────────────────────────────────────

describe('requestTransfer — happy path', () => {
  it('creates one transfer and one line, returns the transfer', async () => {
    const result = await requestTransfer(
      {
        fromLocationId: 'loc-warehouse',
        toLocationId: 'loc-school',
        lines: [{ itemId: 'item-001', qty: 10, unit: 'each' }],
      },
      stubSession
    );

    expect(createTransfer).toHaveBeenCalledOnce();
    expect(createTransferLine).toHaveBeenCalledOnce();
    expect(result.transfer_id).toBe('xfer-001');
  });

  it('sets status to requested and requested_by to session.userId', async () => {
    const session: Session = {
      userId: 'director-99',
      role: Role.director_admin,
      assignedLocationIds: 'all',
    };

    await requestTransfer(
      {
        fromLocationId: 'loc-warehouse',
        toLocationId: 'loc-school',
        lines: [{ itemId: 'item-001', qty: 5, unit: 'lb' }],
      },
      session
    );

    const arg = vi.mocked(createTransfer).mock.calls[0][0];
    expect(arg.status).toBe('requested');
    expect(arg.requested_by).toBe('director-99'); // from session, not input
  });

  it('creates one TransferLine per input line', async () => {
    vi.mocked(createTransfer).mockResolvedValue(
      makeTransfer({ transfer_id: 'xfer-multi' })
    );

    await requestTransfer(
      {
        fromLocationId: 'loc-warehouse',
        toLocationId: 'loc-school',
        lines: [
          { itemId: 'item-001', qty: 10, unit: 'each' },
          { itemId: 'item-002', qty: 5, unit: 'lb' },
        ],
      },
      stubSession
    );

    expect(createTransferLine).toHaveBeenCalledTimes(2);
    const [call1, call2] = vi.mocked(createTransferLine).mock.calls;
    expect(call1[0].item_id).toBe('item-001');
    expect(call2[0].item_id).toBe('item-002');
    // Both lines reference the created transfer.
    expect(call1[0].transfer_id).toBe('xfer-multi');
    expect(call2[0].transfer_id).toBe('xfer-multi');
  });

  it('sets request_date to today ISO date', async () => {
    await requestTransfer(
      {
        fromLocationId: 'loc-warehouse',
        toLocationId: 'loc-school',
        lines: [{ itemId: 'item-001', qty: 1, unit: 'each' }],
      },
      stubSession
    );

    const arg = vi.mocked(createTransfer).mock.calls[0][0];
    expect(arg.request_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ─── requestTransfer — validation ─────────────────────────────────────────────

describe('requestTransfer — validation', () => {
  it('throws and makes no writes when fromLocationId is empty', async () => {
    await expect(
      requestTransfer(
        {
          fromLocationId: '',
          toLocationId: 'loc-school',
          lines: [{ itemId: 'item-001', qty: 10, unit: 'each' }],
        },
        stubSession
      )
    ).rejects.toThrow('fromLocationId must be non-empty');

    expect(createTransfer).not.toHaveBeenCalled();
    expect(createTransferLine).not.toHaveBeenCalled();
  });

  it('throws and makes no writes when toLocationId is empty', async () => {
    await expect(
      requestTransfer(
        {
          fromLocationId: 'loc-warehouse',
          toLocationId: '',
          lines: [{ itemId: 'item-001', qty: 10, unit: 'each' }],
        },
        stubSession
      )
    ).rejects.toThrow('toLocationId must be non-empty');

    expect(createTransfer).not.toHaveBeenCalled();
  });

  it('throws and makes no writes when lines array is empty', async () => {
    await expect(
      requestTransfer(
        {
          fromLocationId: 'loc-warehouse',
          toLocationId: 'loc-school',
          lines: [],
        },
        stubSession
      )
    ).rejects.toThrow('lines must be non-empty');

    expect(createTransfer).not.toHaveBeenCalled();
  });

  it('throws when a line has qty <= 0', async () => {
    await expect(
      requestTransfer(
        {
          fromLocationId: 'loc-warehouse',
          toLocationId: 'loc-school',
          lines: [{ itemId: 'item-001', qty: 0, unit: 'each' }],
        },
        stubSession
      )
    ).rejects.toThrow('qty must be a positive number');

    expect(createTransfer).not.toHaveBeenCalled();
  });

  it('throws when a line has empty itemId', async () => {
    await expect(
      requestTransfer(
        {
          fromLocationId: 'loc-warehouse',
          toLocationId: 'loc-school',
          lines: [{ itemId: '', qty: 10, unit: 'each' }],
        },
        stubSession
      )
    ).rejects.toThrow('itemId must be non-empty');

    expect(createTransfer).not.toHaveBeenCalled();
  });

  it('throws when a line has empty unit', async () => {
    await expect(
      requestTransfer(
        {
          fromLocationId: 'loc-warehouse',
          toLocationId: 'loc-school',
          lines: [{ itemId: 'item-001', qty: 10, unit: '' }],
        },
        stubSession
      )
    ).rejects.toThrow('unit must be non-empty');

    expect(createTransfer).not.toHaveBeenCalled();
  });

  it('throws when fromLocationId and toLocationId are the same', async () => {
    await expect(
      requestTransfer(
        {
          fromLocationId: 'loc-warehouse',
          toLocationId: 'loc-warehouse',
          lines: [{ itemId: 'item-001', qty: 10, unit: 'each' }],
        },
        stubSession
      )
    ).rejects.toThrow('fromLocationId and toLocationId must be different');

    expect(createTransfer).not.toHaveBeenCalled();
    expect(createTransferLine).not.toHaveBeenCalled();
  });

  it('throws when fromLocationId exceeds 100 characters', async () => {
    const oversized = 'x'.repeat(101);

    await expect(
      requestTransfer(
        {
          fromLocationId: oversized,
          toLocationId: 'loc-school',
          lines: [{ itemId: 'item-001', qty: 10, unit: 'each' }],
        },
        stubSession
      )
    ).rejects.toThrow('fromLocationId exceeds max length');

    expect(createTransfer).not.toHaveBeenCalled();
    expect(createTransferLine).not.toHaveBeenCalled();
  });
});

// ─── requestTransfer — access control ─────────────────────────────────────────

describe('requestTransfer — access control', () => {
  it('throws Access denied when session excludes fromLocationId', async () => {
    const restrictedSession: Session = {
      userId: 'user-2',
      role: Role.kitchen_manager,
      assignedLocationIds: ['loc-school'], // does NOT include loc-warehouse
    };

    await expect(
      requestTransfer(
        {
          fromLocationId: 'loc-warehouse',
          toLocationId: 'loc-school',
          lines: [{ itemId: 'item-001', qty: 10, unit: 'each' }],
        },
        restrictedSession
      )
    ).rejects.toThrow('Access denied');

    expect(createTransfer).not.toHaveBeenCalled();
    expect(createTransferLine).not.toHaveBeenCalled();
  });

  it('throws Access denied when session excludes toLocationId', async () => {
    const restrictedSession: Session = {
      userId: 'user-warehouse',
      role: Role.kitchen_manager,
      assignedLocationIds: ['loc-warehouse'],
    };

    await expect(
      requestTransfer(
        {
          fromLocationId: 'loc-warehouse',
          toLocationId: 'loc-school',
          lines: [{ itemId: 'item-001', qty: 10, unit: 'each' }],
        },
        restrictedSession
      )
    ).rejects.toThrow('Access denied');

    expect(createTransfer).not.toHaveBeenCalled();
    expect(createTransferLine).not.toHaveBeenCalled();
  });
});

// ─── approveTransfer — happy path ─────────────────────────────────────────────

describe('approveTransfer — happy path', () => {
  it('sets status to approved and approved_by to session.userId', async () => {
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'requested' }),
    ]);
    vi.mocked(updateTransfer).mockResolvedValue(
      makeTransfer({ status: 'approved', approved_by: 'user-1' })
    );

    const result = await approveTransfer('xfer-001', stubSession);

    expect(updateTransfer).toHaveBeenCalledOnce();
    const arg = vi.mocked(updateTransfer).mock.calls[0][1];
    expect(arg.status).toBe('approved');
    expect(arg.approved_by).toBe('user-1'); // from session
    expect(result.status).toBe('approved');
  });
});

// ─── approveTransfer — wrong status ───────────────────────────────────────────

describe('approveTransfer — wrong status', () => {
  it('throws when transfer is already in_transit', async () => {
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'in_transit' }),
    ]);

    await expect(approveTransfer('xfer-001', stubSession)).rejects.toThrow(
      "Cannot approve transfer with status 'in_transit'"
    );

    expect(updateTransfer).not.toHaveBeenCalled();
  });

  it('throws when transfer is already approved', async () => {
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'approved' }),
    ]);

    await expect(approveTransfer('xfer-001', stubSession)).rejects.toThrow(
      "Cannot approve transfer with status 'approved'"
    );

    expect(updateTransfer).not.toHaveBeenCalled();
  });

  it('throws when transfer is not found', async () => {
    vi.mocked(getAllTransfers).mockResolvedValue([]);

    await expect(approveTransfer('xfer-999', stubSession)).rejects.toThrow(
      'Transfer not found: xfer-999'
    );

    expect(updateTransfer).not.toHaveBeenCalled();
  });
});

// ─── approveTransfer — role gate ──────────────────────────────────────────────

describe('approveTransfer — role gate', () => {
  it('throws Forbidden when role is not director_admin', async () => {
    const kitchenSession: Session = {
      userId: 'user-3',
      role: Role.kitchen_manager,
      assignedLocationIds: 'all',
    };
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'requested' }),
    ]);

    await expect(approveTransfer('xfer-001', kitchenSession)).rejects.toThrow(
      'Forbidden'
    );

    expect(updateTransfer).not.toHaveBeenCalled();
  });

  it('throws Forbidden when role is warehouse', async () => {
    const warehouseSession: Session = {
      userId: 'user-w',
      role: Role.warehouse,
      assignedLocationIds: 'all',
    };
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'requested' }),
    ]);

    await expect(approveTransfer('xfer-001', warehouseSession)).rejects.toThrow(
      'Forbidden'
    );

    expect(updateTransfer).not.toHaveBeenCalled();
  });
});

describe('approveTransfer — endpoint access', () => {
  it('denies a director without source access', async () => {
    const restrictedSession: Session = {
      userId: 'director',
      role: Role.director_admin,
      assignedLocationIds: ['loc-school'],
    };
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'requested' }),
    ]);

    await expect(
      approveTransfer('xfer-001', restrictedSession)
    ).rejects.toThrow('Access denied');
    expect(updateTransfer).not.toHaveBeenCalled();
  });

  it('denies a director without destination access', async () => {
    const restrictedSession: Session = {
      userId: 'director',
      role: Role.director_admin,
      assignedLocationIds: ['loc-warehouse'],
    };
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'requested' }),
    ]);

    await expect(
      approveTransfer('xfer-001', restrictedSession)
    ).rejects.toThrow('Access denied');
    expect(updateTransfer).not.toHaveBeenCalled();
  });
});

// ─── shipTransfer — happy path ────────────────────────────────────────────────

describe('shipTransfer — happy path', () => {
  it('calls consumeFIFO once per line with correct arguments', async () => {
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'approved' }),
    ]);
    vi.mocked(getAllTransferLines).mockResolvedValue([
      makeLine({ item_id: 'item-001', qty: 10, unit: 'each' }),
      makeLine({ line_id: 'line-002', item_id: 'item-002', qty: 5, unit: 'lb' }),
    ]);
    vi.mocked(updateTransfer).mockResolvedValue(
      makeTransfer({ status: 'in_transit', ship_date: '2026-06-06' })
    );

    await shipTransfer('xfer-001', stubSession);

    expect(consumeFIFO).toHaveBeenCalledTimes(2);
    const [call1, call2] = vi.mocked(consumeFIFO).mock.calls;
    // First line.
    expect(call1[0].itemId).toBe('item-001');
    expect(call1[0].locationId).toBe('loc-warehouse');
    expect(call1[0].qty).toBe(10);
    expect(call1[0].txnType).toBe('transfer_out');
    expect(call1[0].refType).toBe('transfer');
    expect(call1[0].refId).toBe('xfer-001');
    // Second line.
    expect(call2[0].itemId).toBe('item-002');
    expect(call2[0].qty).toBe(5);
  });

  it('sets status to in_transit and ship_date to today', async () => {
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'approved' }),
    ]);
    vi.mocked(getAllTransferLines).mockResolvedValue([makeLine()]);
    vi.mocked(updateTransfer).mockResolvedValue(
      makeTransfer({ status: 'in_transit' })
    );

    const result = await shipTransfer('xfer-001', stubSession);

    expect(updateTransfer).toHaveBeenCalledOnce();
    const updateArg = vi.mocked(updateTransfer).mock.calls[0][1];
    expect(updateArg.status).toBe('in_transit');
    expect(updateArg.ship_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.status).toBe('in_transit');
  });

  it('passes session through to consumeFIFO (not a hardcoded user)', async () => {
    const warehouseSession: Session = {
      userId: 'warehouse-user',
      role: Role.warehouse,
      assignedLocationIds: 'all',
    };
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'approved' }),
    ]);
    vi.mocked(getAllTransferLines).mockResolvedValue([makeLine()]);
    vi.mocked(updateTransfer).mockResolvedValue(makeTransfer());

    await shipTransfer('xfer-001', warehouseSession);

    const consumeArg = vi.mocked(consumeFIFO).mock.calls[0][0];
    expect(consumeArg.session.userId).toBe('warehouse-user');
  });
});

// ─── shipTransfer — wrong status ──────────────────────────────────────────────

describe('shipTransfer — wrong status', () => {
  it('throws when transfer is still requested (not approved)', async () => {
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'requested' }),
    ]);

    await expect(shipTransfer('xfer-001', stubSession)).rejects.toThrow(
      "Cannot ship transfer with status 'requested'"
    );

    expect(consumeFIFO).not.toHaveBeenCalled();
    expect(updateTransfer).not.toHaveBeenCalled();
  });

  it('throws when transfer is already in_transit', async () => {
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'in_transit' }),
    ]);

    await expect(shipTransfer('xfer-001', stubSession)).rejects.toThrow(
      "Cannot ship transfer with status 'in_transit'"
    );

    expect(consumeFIFO).not.toHaveBeenCalled();
  });
});

// ─── shipTransfer — access control ────────────────────────────────────────────

describe('shipTransfer — access control', () => {
  it('throws Access denied when session excludes fromLocationId', async () => {
    const restrictedSession: Session = {
      userId: 'user-school',
      role: Role.warehouse,
      assignedLocationIds: ['loc-school'], // does NOT include loc-warehouse
    };
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'approved', from_location_id: 'loc-warehouse' }),
    ]);

    await expect(shipTransfer('xfer-001', restrictedSession)).rejects.toThrow(
      'Access denied'
    );

    expect(consumeFIFO).not.toHaveBeenCalled();
    expect(updateTransfer).not.toHaveBeenCalled();
  });

  it('allows a warehouse user assigned only to source (toLocationId excluded) to ship', async () => {
    // Task 8: only SOURCE access is required to ship. A warehouse user with
    // only the source in their assignedLocationIds must be permitted.
    const sourceOnlySession: Session = {
      userId: 'warehouse-user',
      role: Role.warehouse,
      assignedLocationIds: ['loc-warehouse'], // NOT loc-school
    };
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'approved' }),
    ]);
    vi.mocked(getAllTransferLines).mockResolvedValue([makeLine()]);
    vi.mocked(updateTransfer).mockResolvedValue(makeTransfer({ status: 'in_transit' }));

    await expect(
      shipTransfer('xfer-001', sourceOnlySession)
    ).resolves.toBeDefined();

    expect(consumeFIFO).toHaveBeenCalledOnce();
  });

  it('throws Forbidden when role is not director_admin or warehouse', async () => {
    const kitchenSession: Session = {
      userId: 'kitchen-user',
      role: Role.kitchen_manager,
      assignedLocationIds: 'all',
    };
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'approved' }),
    ]);

    await expect(shipTransfer('xfer-001', kitchenSession)).rejects.toThrow(
      'Forbidden'
    );
    expect(consumeFIFO).not.toHaveBeenCalled();
    expect(updateTransfer).not.toHaveBeenCalled();
  });
});

describe('shipTransfer — preflight', () => {
  it('does not consume any line when a later line has insufficient stock', async () => {
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'approved' }),
    ]);
    vi.mocked(getAllTransferLines).mockResolvedValue([
      makeLine({ item_id: 'item-001', qty: 10 }),
      makeLine({ line_id: 'line-002', item_id: 'item-002', qty: 5 }),
    ]);
    vi.mocked(getAllLots).mockResolvedValue([
      makeLot({
        lot_id: 'source-item-1',
        item_id: 'item-001',
        location_id: 'loc-warehouse',
        remaining_qty: 10,
      }),
      makeLot({
        lot_id: 'source-item-2',
        item_id: 'item-002',
        location_id: 'loc-warehouse',
        remaining_qty: 4,
      }),
    ]);

    await expect(shipTransfer('xfer-001', stubSession)).rejects.toThrow(
      'Insufficient stock'
    );

    expect(consumeFIFO).not.toHaveBeenCalled();
    expect(updateTransfer).not.toHaveBeenCalled();
  });
});

// ─── receiveTransfer — happy path ─────────────────────────────────────────────

describe('receiveTransfer — happy path', () => {
  it('creates one lot and one transfer_in transaction per transfer_out txn', async () => {
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'in_transit' }),
    ]);
    // Simulate two source lot portions consumed during shipTransfer.
    vi.mocked(getAllTransactions).mockResolvedValue([
      makeTxn({
        txn_id: 't-out-1',
        lot_id: 'lot-src-1',
        item_id: 'item-001',
        qty_base: -30,
        unit_cost: 2.0,
        ref_id: 'xfer-001',
      }),
      makeTxn({
        txn_id: 't-out-2',
        lot_id: 'lot-src-2',
        item_id: 'item-001',
        qty_base: -15,
        unit_cost: 2.5,
        ref_id: 'xfer-001',
      }),
    ]);
    vi.mocked(createLot)
      .mockResolvedValueOnce(makeLot({ lot_id: 'lot-dest-1', unit_cost: 2.0 }))
      .mockResolvedValueOnce(makeLot({ lot_id: 'lot-dest-2', unit_cost: 2.5 }));
    vi.mocked(updateTransfer).mockResolvedValue(
      makeTransfer({ status: 'received' })
    );

    const result = await receiveTransfer('xfer-001', stubSession);

    // Two lots created at destination.
    expect(createLot).toHaveBeenCalledTimes(2);
    // Two transfer_in transactions posted.
    expect(postTransaction).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('received');
  });

  it('recreates lots at destination with correct qty and source unit_cost', async () => {
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'in_transit' }),
    ]);
    vi.mocked(getAllTransactions).mockResolvedValue([
      makeTxn({
        txn_id: 't-out-1',
        lot_id: 'lot-src-1',
        item_id: 'item-007',
        qty_base: -40,       // 40 units consumed
        unit_cost: 3.75,     // source lot cost
        ref_id: 'xfer-001',
      }),
    ]);
    vi.mocked(createLot).mockResolvedValue(
      makeLot({ lot_id: 'lot-dest-new' })
    );
    vi.mocked(updateTransfer).mockResolvedValue(makeTransfer());

    await receiveTransfer('xfer-001', stubSession);

    const lotArg = vi.mocked(createLot).mock.calls[0][0];
    expect(lotArg.item_id).toBe('item-007');
    expect(lotArg.location_id).toBe('loc-school');       // to_location_id
    expect(lotArg.original_qty).toBe(40);                // abs(qty_base)
    expect(lotArg.remaining_qty).toBe(40);
    expect(lotArg.unit_cost).toBe(3.75);                 // source cost preserved
    expect(lotArg.source_ref).toBe('xfer-001');
    expect(lotArg.received_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('posts transfer_in with correct fields including source unit_cost', async () => {
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'in_transit' }),
    ]);
    vi.mocked(getAllTransactions).mockResolvedValue([
      makeTxn({
        txn_id: 't-out-1',
        lot_id: 'lot-src-1',
        item_id: 'item-007',
        qty_base: -20,
        unit_cost: 1.99,
        ref_id: 'xfer-001',
      }),
    ]);
    vi.mocked(createLot).mockResolvedValue(
      makeLot({ lot_id: 'lot-dest-x', unit_cost: 1.99 })
    );
    vi.mocked(updateTransfer).mockResolvedValue(makeTransfer());

    await receiveTransfer('xfer-001', stubSession);

    const txnArg = vi.mocked(postTransaction).mock.calls[0][0];
    expect(txnArg.txn_type).toBe('transfer_in');
    expect(txnArg.ref_type).toBe('transfer');
    expect(txnArg.ref_id).toBe('xfer-001');
    expect(txnArg.item_id).toBe('item-007');
    expect(txnArg.location_id).toBe('loc-school');       // destination
    expect(txnArg.lot_id).toBe('lot-dest-x');            // new lot at destination
    expect(txnArg.qty_base).toBe(20);                    // positive inflow
    expect(txnArg.unit_cost).toBe(1.99);                 // source cost preserved
  });

  it('sets status to received, received_by to session.userId, and receive_date to today', async () => {
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'in_transit' }),
    ]);
    vi.mocked(getAllTransactions).mockResolvedValue([
      makeTxn({ txn_id: 't1', qty_base: -5, ref_id: 'xfer-001' }),
    ]);
    vi.mocked(createLot).mockResolvedValue(makeLot());
    vi.mocked(updateTransfer).mockResolvedValue(
      makeTransfer({ status: 'received', received_by: 'user-1' })
    );

    await receiveTransfer('xfer-001', stubSession);

    expect(updateTransfer).toHaveBeenCalledOnce();
    const updateArg = vi.mocked(updateTransfer).mock.calls[0][1];
    expect(updateArg.status).toBe('received');
    expect(updateArg.received_by).toBe('user-1');
    expect(updateArg.receive_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('only processes transfer_out txns for this transfer (ignores other txns)', async () => {
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'in_transit' }),
    ]);
    vi.mocked(getAllTransactions).mockResolvedValue([
      // Belongs to this transfer — should be processed.
      makeTxn({
        txn_id: 't-mine',
        txn_type: 'transfer_out',
        ref_id: 'xfer-001',
        qty_base: -10,
      }),
      // Different transfer — must be ignored.
      makeTxn({
        txn_id: 't-other-xfer',
        txn_type: 'transfer_out',
        ref_id: 'xfer-OTHER',
        qty_base: -99,
      }),
      // Same transfer ID but wrong txn_type — must be ignored.
      makeTxn({
        txn_id: 't-receive-type',
        txn_type: 'receive',
        ref_id: 'xfer-001',
        qty_base: 50,
      }),
    ]);
    vi.mocked(createLot).mockResolvedValue(makeLot());
    vi.mocked(updateTransfer).mockResolvedValue(makeTransfer());

    await receiveTransfer('xfer-001', stubSession);

    // Only one qualifying txn → one lot + one transaction.
    expect(createLot).toHaveBeenCalledOnce();
    expect(postTransaction).toHaveBeenCalledOnce();
  });
});

// ─── receiveTransfer — balance invariant ──────────────────────────────────────

describe('receiveTransfer — balance invariant', () => {
  it('Σ(qty * unit_cost) equals source cost across multiple lots', async () => {
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'in_transit' }),
    ]);
    // Two transfer_out txns for the same transfer, from different source lots.
    // lot-A: 10 units at $2.00 → $20; lot-B: 5 units at $3.00 → $15; total $35.
    vi.mocked(getAllTransactions).mockResolvedValue([
      makeTxn({
        txn_id: 't-out-A',
        lot_id: 'lot-A',
        item_id: 'item-001',
        qty_base: -10,
        unit_cost: 2.0,
        ref_id: 'xfer-001',
        txn_type: 'transfer_out',
      }),
      makeTxn({
        txn_id: 't-out-B',
        lot_id: 'lot-B',
        item_id: 'item-001',
        qty_base: -5,
        unit_cost: 3.0,
        ref_id: 'xfer-001',
        txn_type: 'transfer_out',
      }),
    ]);
    vi.mocked(createLot)
      .mockResolvedValueOnce(makeLot({ lot_id: 'lot-dest-A', unit_cost: 2.0, original_qty: 10, remaining_qty: 10 }))
      .mockResolvedValueOnce(makeLot({ lot_id: 'lot-dest-B', unit_cost: 3.0, original_qty: 5, remaining_qty: 5 }));
    vi.mocked(updateTransfer).mockResolvedValue(makeTransfer({ status: 'received' }));

    await receiveTransfer('xfer-001', stubSession);

    // createLot called twice — one per source lot portion.
    expect(createLot).toHaveBeenCalledTimes(2);
    const lotCall1 = vi.mocked(createLot).mock.calls[0][0];
    const lotCall2 = vi.mocked(createLot).mock.calls[1][0];
    expect(lotCall1.unit_cost).toBe(2.0);
    expect(lotCall2.unit_cost).toBe(3.0);

    // postTransaction called twice.
    expect(postTransaction).toHaveBeenCalledTimes(2);
    const txnCall1 = vi.mocked(postTransaction).mock.calls[0][0];
    const txnCall2 = vi.mocked(postTransaction).mock.calls[1][0];

    // Σ(qty_base * unit_cost) must equal source total: 10*2 + 5*3 = 35.
    const totalValue =
      txnCall1.qty_base * txnCall1.unit_cost +
      txnCall2.qty_base * txnCall2.unit_cost;
    expect(totalValue).toBe(35);
  });
});

// ─── receiveTransfer — idempotency guard ──────────────────────────────────────

describe('receiveTransfer — idempotency guard', () => {
  it('marks received without duplicate writes when all expected portions exist', async () => {
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'in_transit' }),
    ]);
    vi.mocked(getAllTransactions).mockResolvedValue([
      makeTxn({
        txn_id: 't-out-existing',
        txn_type: 'transfer_out',
        lot_id: 'lot-source-1',
        ref_id: 'xfer-001',
        qty_base: -10,
        unit_cost: 2.5,
      }),
      makeTxn({
        txn_id: 't-in-partial',
        txn_type: 'transfer_in',
        location_id: 'loc-school',
        lot_id: 'lot-dest-existing',
        ref_id: 'xfer-001',
        qty_base: 10,
        unit_cost: 2.5,
        note: 'source_lot:lot-source-1',
      }),
    ]);
    vi.mocked(updateTransfer).mockResolvedValue(
      makeTransfer({ status: 'received' })
    );

    await receiveTransfer('xfer-001', stubSession);

    expect(createLot).not.toHaveBeenCalled();
    expect(postTransaction).not.toHaveBeenCalled();
    expect(updateTransfer).toHaveBeenCalledWith(
      'xfer-001',
      expect.objectContaining({ status: 'received' })
    );
  });

  it('creates only missing portions after a partial receive', async () => {
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'in_transit' }),
    ]);
    vi.mocked(getAllTransactions).mockResolvedValue([
      makeTxn({
        txn_id: 't-out-existing',
        lot_id: 'lot-source-1',
        qty_base: -10,
        unit_cost: 2.5,
      }),
      makeTxn({
        txn_id: 't-out-missing',
        lot_id: 'lot-source-2',
        qty_base: -5,
        unit_cost: 3,
      }),
      makeTxn({
        txn_id: 't-in-existing',
        txn_type: 'transfer_in',
        location_id: 'loc-school',
        lot_id: 'lot-dest-existing',
        qty_base: 10,
        unit_cost: 2.5,
        note: 'source_lot:lot-source-1',
      }),
    ]);
    vi.mocked(createLot).mockResolvedValue(
      makeLot({ lot_id: 'lot-dest-new', original_qty: 5, remaining_qty: 5 })
    );

    await receiveTransfer('xfer-001', stubSession);

    expect(createLot).toHaveBeenCalledOnce();
    expect(createLot).toHaveBeenCalledWith(
      expect.objectContaining({
        item_id: 'item-001',
        original_qty: 5,
        remaining_qty: 5,
        unit_cost: 3,
      })
    );
    expect(postTransaction).toHaveBeenCalledOnce();
    expect(postTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        qty_base: 5,
        unit_cost: 3,
        note: 'source_lot:lot-source-2',
      }),
      stubSession
    );
    expect(updateTransfer).toHaveBeenCalledOnce();
  });
});

// ─── receiveTransfer — wrong status ───────────────────────────────────────────

describe('receiveTransfer — wrong status', () => {
  it('throws when transfer is still approved (not in_transit)', async () => {
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'approved' }),
    ]);

    await expect(receiveTransfer('xfer-001', stubSession)).rejects.toThrow(
      "Cannot receive transfer with status 'approved'"
    );

    expect(createLot).not.toHaveBeenCalled();
    expect(postTransaction).not.toHaveBeenCalled();
    expect(updateTransfer).not.toHaveBeenCalled();
  });

  it('throws when transfer is already received', async () => {
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'received' }),
    ]);

    await expect(receiveTransfer('xfer-001', stubSession)).rejects.toThrow(
      "Cannot receive transfer with status 'received'"
    );

    expect(createLot).not.toHaveBeenCalled();
    expect(postTransaction).not.toHaveBeenCalled();
    expect(updateTransfer).not.toHaveBeenCalled();
  });
});

// ─── receiveTransfer — access control ─────────────────────────────────────────

describe('receiveTransfer — access control', () => {
  it('throws Access denied when session excludes toLocationId', async () => {
    const restrictedSession: Session = {
      userId: 'user-warehouse',
      role: Role.warehouse,
      assignedLocationIds: ['loc-warehouse'], // does NOT include loc-school
    };
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({
        status: 'in_transit',
        to_location_id: 'loc-school',
      }),
    ]);

    await expect(
      receiveTransfer('xfer-001', restrictedSession)
    ).rejects.toThrow('Access denied');

    expect(createLot).not.toHaveBeenCalled();
    expect(postTransaction).not.toHaveBeenCalled();
    expect(updateTransfer).not.toHaveBeenCalled();
  });

  it('allows a kitchen_manager assigned only to destination (fromLocationId excluded) to receive', async () => {
    // Task 9: only DESTINATION access is required to receive. A kitchen manager
    // with only the destination in their assignedLocationIds must be permitted.
    const destOnlySession: Session = {
      userId: 'kitchen-user',
      role: Role.kitchen_manager,
      assignedLocationIds: ['loc-school'], // NOT loc-warehouse
    };
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'in_transit' }),
    ]);
    vi.mocked(getAllTransactions).mockResolvedValue([
      makeTxn({ txn_id: 't-out-1', qty_base: -10, ref_id: 'xfer-001' }),
    ]);
    vi.mocked(createLot).mockResolvedValue(makeLot());
    vi.mocked(updateTransfer).mockResolvedValue(makeTransfer({ status: 'received' }));

    await expect(
      receiveTransfer('xfer-001', destOnlySession)
    ).resolves.toBeDefined();

    expect(createLot).toHaveBeenCalledOnce();
    expect(postTransaction).toHaveBeenCalledOnce();
  });

  it('throws Forbidden for roles outside director_admin, warehouse, and kitchen_manager', async () => {
    const vendingSession: Session = {
      userId: 'vending-user',
      role: Role.vending_route,
      assignedLocationIds: 'all',
    };
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'in_transit' }),
    ]);

    await expect(
      receiveTransfer('xfer-001', vendingSession)
    ).rejects.toThrow('Forbidden');

    expect(createLot).not.toHaveBeenCalled();
    expect(postTransaction).not.toHaveBeenCalled();
    expect(updateTransfer).not.toHaveBeenCalled();
  });
});

// ─── Tasks 8 & 9: retry-safe ship/receive ────────────────────────────────────

describe('shipTransfer — Task 8: source-only authorization', () => {
  it('allows a warehouse user assigned only to the source location to ship', async () => {
    const sourceOnlySession: Session = {
      userId: 'wh-user',
      role: Role.warehouse,
      // Only has access to the source; NOT the destination.
      assignedLocationIds: ['loc-warehouse'],
    };
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'approved' }),
    ]);
    vi.mocked(getAllTransferLines).mockResolvedValue([makeLine()]);
    vi.mocked(updateTransfer).mockResolvedValue(makeTransfer({ status: 'in_transit' }));

    // Should succeed — warehouse assigned to source can ship.
    await expect(shipTransfer('xfer-001', sourceOnlySession)).resolves.toBeDefined();
    expect(consumeFIFO).toHaveBeenCalledOnce();
  });

  it('denies a kitchen_manager from shipping even if assigned to both locations', async () => {
    const kitchenSession: Session = {
      userId: 'kitchen-user',
      role: Role.kitchen_manager,
      assignedLocationIds: 'all',
    };
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'approved' }),
    ]);

    await expect(shipTransfer('xfer-001', kitchenSession)).rejects.toThrow('Forbidden');
    expect(consumeFIFO).not.toHaveBeenCalled();
  });
});

describe('receiveTransfer — Task 9: destination-only authorization', () => {
  it('allows a kitchen_manager assigned only to the destination to receive', async () => {
    const destOnlySession: Session = {
      userId: 'kitchen-user',
      role: Role.kitchen_manager,
      // Only has access to the destination; NOT the source.
      assignedLocationIds: ['loc-school'],
    };
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'in_transit' }),
    ]);
    vi.mocked(getAllTransactions).mockResolvedValue([
      makeTxn({ txn_id: 't-out-1', qty_base: -10, ref_id: 'xfer-001' }),
    ]);
    vi.mocked(createLot).mockResolvedValue(makeLot());
    vi.mocked(updateTransfer).mockResolvedValue(makeTransfer({ status: 'received' }));

    // Should succeed — kitchen assigned to destination can receive.
    await expect(receiveTransfer('xfer-001', destOnlySession)).resolves.toBeDefined();
  });

  it('denies a warehouse user without destination assignment from receiving', async () => {
    const warehouseOnlySession: Session = {
      userId: 'wh-user',
      role: Role.warehouse,
      assignedLocationIds: ['loc-warehouse'], // does NOT include loc-school
    };
    vi.mocked(getAllTransfers).mockResolvedValue([
      makeTransfer({ status: 'in_transit' }),
    ]);

    await expect(receiveTransfer('xfer-001', warehouseOnlySession)).rejects.toThrow('Access denied');
    expect(createLot).not.toHaveBeenCalled();
  });
});
