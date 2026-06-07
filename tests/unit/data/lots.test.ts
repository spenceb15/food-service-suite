import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lot } from '../../../lib/types';
import {
  IntegrityConflictError,
  RetryableMutationError,
} from '../../../lib/services/errors';

const sheetsMock = vi.hoisted(() => ({
  getRows: vi.fn(),
  appendRow: vi.fn(),
  updateRow: vi.fn(),
  updateRows: vi.fn(),
}));

vi.mock('../../../lib/data/sheets', () => sheetsMock);

import {
  getCanonicalLots,
  ensureLot,
  setLotRemainingById,
  lotToRow,
} from '../../../lib/data/lots';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeLot(overrides: Partial<Lot> = {}): Lot {
  return {
    lot_id: 'lot:recv:v1:abc',
    item_id: 'item-1',
    location_id: 'loc-1',
    received_date: '2026-01-01',
    expiration_date: '2026-12-31',
    original_qty: 100,
    remaining_qty: 80,
    unit_cost: 2.5,
    source_ref: 'rcpt-1',
    ...overrides,
  };
}

function rowsFor(...lots: Lot[]): string[][] {
  return lots.map((lot) => lotToRow(lot).map(String));
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── getCanonicalLots ─────────────────────────────────────────────────────────

describe('getCanonicalLots', () => {
  it('returns a single logical lot for a single physical row', async () => {
    sheetsMock.getRows.mockResolvedValue(rowsFor(makeLot()));

    const result = await getCanonicalLots();

    expect(result).toHaveLength(1);
    expect(result[0].lot_id).toBe('lot:recv:v1:abc');
    expect(result[0].remaining_qty).toBe(80);
  });

  it('collapses two physical rows sharing a lot_id with identical immutable fields to one logical lot', async () => {
    const lot = makeLot({ remaining_qty: 80 });
    const duplicate = makeLot({ remaining_qty: 75 }); // different remaining_qty only
    sheetsMock.getRows.mockResolvedValue(rowsFor(lot, duplicate));

    const result = await getCanonicalLots();

    expect(result).toHaveLength(1);
    expect(result[0].lot_id).toBe('lot:recv:v1:abc');
    // Design choice: use the LAST (most recent) remaining_qty among physical rows.
    // This models the intent that setLotRemainingById overwrites all rows.
    expect(result[0].remaining_qty).toBe(75);
  });

  it('throws IntegrityConflictError when two rows share lot_id but conflict on item_id', async () => {
    sheetsMock.getRows.mockResolvedValue(
      rowsFor(makeLot(), makeLot({ item_id: 'item-2' }))
    );

    await expect(getCanonicalLots()).rejects.toBeInstanceOf(IntegrityConflictError);
  });

  it('throws IntegrityConflictError when two rows share lot_id but conflict on location_id', async () => {
    sheetsMock.getRows.mockResolvedValue(
      rowsFor(makeLot(), makeLot({ location_id: 'loc-2' }))
    );

    await expect(getCanonicalLots()).rejects.toBeInstanceOf(IntegrityConflictError);
  });

  it('throws IntegrityConflictError when two rows share lot_id but conflict on received_date', async () => {
    sheetsMock.getRows.mockResolvedValue(
      rowsFor(makeLot(), makeLot({ received_date: '2026-02-01' }))
    );

    await expect(getCanonicalLots()).rejects.toBeInstanceOf(IntegrityConflictError);
  });

  it('throws IntegrityConflictError when two rows share lot_id but conflict on expiration_date', async () => {
    sheetsMock.getRows.mockResolvedValue(
      rowsFor(makeLot(), makeLot({ expiration_date: '2027-01-01' }))
    );

    await expect(getCanonicalLots()).rejects.toBeInstanceOf(IntegrityConflictError);
  });

  it('throws IntegrityConflictError when two rows share lot_id but conflict on original_qty', async () => {
    sheetsMock.getRows.mockResolvedValue(
      rowsFor(makeLot(), makeLot({ original_qty: 200 }))
    );

    await expect(getCanonicalLots()).rejects.toBeInstanceOf(IntegrityConflictError);
  });

  it('throws IntegrityConflictError when two rows share lot_id but conflict on unit_cost', async () => {
    sheetsMock.getRows.mockResolvedValue(
      rowsFor(makeLot(), makeLot({ unit_cost: 9.99 }))
    );

    await expect(getCanonicalLots()).rejects.toBeInstanceOf(IntegrityConflictError);
  });

  it('throws IntegrityConflictError when two rows share lot_id but conflict on source_ref', async () => {
    sheetsMock.getRows.mockResolvedValue(
      rowsFor(makeLot(), makeLot({ source_ref: 'other-ref' }))
    );

    await expect(getCanonicalLots()).rejects.toBeInstanceOf(IntegrityConflictError);
  });

  it('returns multiple logical lots from distinct lot_ids', async () => {
    sheetsMock.getRows.mockResolvedValue(
      rowsFor(
        makeLot({ lot_id: 'lot-a', remaining_qty: 50 }),
        makeLot({ lot_id: 'lot-b', remaining_qty: 30 })
      )
    );

    const result = await getCanonicalLots();

    expect(result).toHaveLength(2);
    const ids = result.map((l) => l.lot_id).sort();
    expect(ids).toEqual(['lot-a', 'lot-b']);
  });

  it('returns an empty array when there are no lot rows', async () => {
    sheetsMock.getRows.mockResolvedValue([]);

    const result = await getCanonicalLots();

    expect(result).toHaveLength(0);
  });
});

// ─── ensureLot ────────────────────────────────────────────────────────────────

describe('ensureLot', () => {
  it('appends a new lot and returns it when the lot_id is absent', async () => {
    const expected = makeLot();

    sheetsMock.getRows
      .mockResolvedValueOnce([]) // first read: absent
      .mockResolvedValueOnce(rowsFor(expected)); // second read: visible after append

    const result = await ensureLot(expected);

    expect(sheetsMock.appendRow).toHaveBeenCalledOnce();
    expect(sheetsMock.appendRow).toHaveBeenCalledWith('Lots', lotToRow(expected));
    expect(result.value.lot_id).toBe('lot:recv:v1:abc');
    expect(result.outcome).toBe('created');
  });

  it('returns the existing lot without appending when lot exists with identical immutable fields', async () => {
    const existing = makeLot();
    const expected = makeLot({ remaining_qty: 60 }); // remaining_qty differs — OK

    sheetsMock.getRows.mockResolvedValue(rowsFor(existing));

    const result = await ensureLot(expected);

    expect(sheetsMock.appendRow).not.toHaveBeenCalled();
    expect(result.value.lot_id).toBe('lot:recv:v1:abc');
    expect(result.outcome).toBe('existing');
  });

  it('throws IntegrityConflictError when lot_id exists but item_id conflicts', async () => {
    sheetsMock.getRows.mockResolvedValue(rowsFor(makeLot()));
    const expected = makeLot({ item_id: 'item-CONFLICT' });

    await expect(ensureLot(expected)).rejects.toBeInstanceOf(IntegrityConflictError);
    expect(sheetsMock.appendRow).not.toHaveBeenCalled();
  });

  it('throws IntegrityConflictError when lot_id exists but location_id conflicts', async () => {
    sheetsMock.getRows.mockResolvedValue(rowsFor(makeLot()));
    const expected = makeLot({ location_id: 'loc-CONFLICT' });

    await expect(ensureLot(expected)).rejects.toBeInstanceOf(IntegrityConflictError);
    expect(sheetsMock.appendRow).not.toHaveBeenCalled();
  });

  it('throws IntegrityConflictError when lot_id exists but received_date conflicts', async () => {
    sheetsMock.getRows.mockResolvedValue(rowsFor(makeLot()));
    const expected = makeLot({ received_date: '2099-01-01' });

    await expect(ensureLot(expected)).rejects.toBeInstanceOf(IntegrityConflictError);
    expect(sheetsMock.appendRow).not.toHaveBeenCalled();
  });

  it('throws IntegrityConflictError when lot_id exists but expiration_date conflicts', async () => {
    sheetsMock.getRows.mockResolvedValue(rowsFor(makeLot()));
    const expected = makeLot({ expiration_date: '2099-01-01' });

    await expect(ensureLot(expected)).rejects.toBeInstanceOf(IntegrityConflictError);
    expect(sheetsMock.appendRow).not.toHaveBeenCalled();
  });

  it('throws IntegrityConflictError when lot_id exists but original_qty conflicts', async () => {
    sheetsMock.getRows.mockResolvedValue(rowsFor(makeLot()));
    const expected = makeLot({ original_qty: 9999 });

    await expect(ensureLot(expected)).rejects.toBeInstanceOf(IntegrityConflictError);
    expect(sheetsMock.appendRow).not.toHaveBeenCalled();
  });

  it('throws IntegrityConflictError when lot_id exists but unit_cost conflicts', async () => {
    sheetsMock.getRows.mockResolvedValue(rowsFor(makeLot()));
    const expected = makeLot({ unit_cost: 99.99 });

    await expect(ensureLot(expected)).rejects.toBeInstanceOf(IntegrityConflictError);
    expect(sheetsMock.appendRow).not.toHaveBeenCalled();
  });

  it('throws IntegrityConflictError when lot_id exists but source_ref conflicts', async () => {
    sheetsMock.getRows.mockResolvedValue(rowsFor(makeLot()));
    const expected = makeLot({ source_ref: 'rcpt-CONFLICT' });

    await expect(ensureLot(expected)).rejects.toBeInstanceOf(IntegrityConflictError);
    expect(sheetsMock.appendRow).not.toHaveBeenCalled();
  });

  it('throws RetryableMutationError when appended lot is not visible on re-read', async () => {
    const expected = makeLot();

    sheetsMock.getRows
      .mockResolvedValueOnce([]) // first read: absent
      .mockResolvedValueOnce([]); // second read: still absent (visibility failure)

    await expect(ensureLot(expected)).rejects.toBeInstanceOf(RetryableMutationError);
    expect(sheetsMock.appendRow).toHaveBeenCalledOnce();
  });
});

// ─── setLotRemainingById ──────────────────────────────────────────────────────

describe('setLotRemainingById', () => {
  it('updates every physical row sharing the lot_id with the new remaining_qty', async () => {
    const lot = makeLot({ remaining_qty: 80 });
    const duplicate = makeLot({ remaining_qty: 75 }); // second physical row

    sheetsMock.getRows.mockResolvedValue(rowsFor(lot, duplicate));

    await setLotRemainingById('lot:recv:v1:abc', 50);

    // updateRow must be called for each physical row with the given lot_id.
    expect(sheetsMock.updateRow).toHaveBeenCalledTimes(2);
  });

  it('calls updateRow with the new remaining_qty on the correct row', async () => {
    const lot = makeLot({ remaining_qty: 80 });
    sheetsMock.getRows.mockResolvedValue(rowsFor(lot));

    await setLotRemainingById('lot:recv:v1:abc', 42);

    const [tab, rowIndex, values] = sheetsMock.updateRow.mock.calls[0];
    expect(tab).toBe('Lots');
    // rowIndex 1 = first data row (0-based among data rows → 1-based index passed to updateRow)
    expect(rowIndex).toBe(1);
    // remaining_qty is column index 6
    expect(values[6]).toBe(42);
  });

  it('throws when no rows match the lot_id', async () => {
    sheetsMock.getRows.mockResolvedValue([]);

    await expect(setLotRemainingById('nonexistent-lot', 0)).rejects.toThrow();
  });
});
