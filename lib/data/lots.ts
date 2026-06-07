import 'server-only';

import { getRows, appendRow, updateRow } from './sheets';
import { parseNum } from '../types';
import { normalizeLedgerNumber } from '../services/deterministicIds';
import {
  IntegrityConflictError,
  RetryableMutationError,
} from '../services/errors';
import type { Lot } from '../types';

// Tab column order (0-based):
// lot_id, item_id, location_id, received_date, expiration_date,
// original_qty, remaining_qty, unit_cost, source_ref

const TAB = 'Lots';

function rowToLot(row: string[]): Lot {
  return {
    lot_id: row[0] ?? '',
    item_id: row[1] ?? '',
    location_id: row[2] ?? '',
    received_date: row[3] ?? '',
    expiration_date: (row[4] ?? '') !== '' ? row[4] : undefined,
    original_qty: parseNum(row[5]),
    remaining_qty: parseNum(row[6]),
    unit_cost: parseNum(row[7]),
    source_ref: row[8] ?? '',
  };
}

function lotToRow(lot: Lot): unknown[] {
  return [
    lot.lot_id,
    lot.item_id,
    lot.location_id,
    lot.received_date,
    lot.expiration_date ?? '',
    lot.original_qty,
    lot.remaining_qty,
    lot.unit_cost,
    lot.source_ref,
  ];
}

export { rowToLot, lotToRow };

/**
 * Checks whether two lots agree on every immutable field.
 * Immutable fields: item_id, location_id, received_date, expiration_date,
 * original_qty, unit_cost, source_ref.
 * remaining_qty is mutable — it is updated as stock is consumed.
 */
function immutableFieldsMatch(a: Lot, b: Lot): boolean {
  return (
    a.item_id === b.item_id &&
    a.location_id === b.location_id &&
    a.received_date === b.received_date &&
    (a.expiration_date ?? '') === (b.expiration_date ?? '') &&
    normalizeLedgerNumber(a.original_qty) ===
      normalizeLedgerNumber(b.original_qty) &&
    normalizeLedgerNumber(a.unit_cost) === normalizeLedgerNumber(b.unit_cost) &&
    a.source_ref === b.source_ref
  );
}

export async function getAllLots(): Promise<Lot[]> {
  const rows = await getRows(TAB);
  return rows.filter((r) => r[0] !== '').map(rowToLot);
}

/**
 * Returns one logical lot per unique lot_id, collapsing duplicate physical rows.
 *
 * Within each group of physical rows sharing a lot_id:
 *  - Immutable fields must all agree; throws IntegrityConflictError on mismatch.
 *  - remaining_qty: the LAST physical row's value is used. This models the intent
 *    that setLotRemainingById overwrites all physical rows to the same value —
 *    the last row seen is the most recently written reconciled value.
 */
export async function getCanonicalLots(): Promise<Lot[]> {
  const rows = await getRows(TAB);
  const groups = new Map<string, Lot[]>();

  for (const row of rows) {
    if (!(row[0] ?? '').trim()) continue; // skip blank rows
    const lot = rowToLot(row);
    const group = groups.get(lot.lot_id);
    if (group) {
      group.push(lot);
    } else {
      groups.set(lot.lot_id, [lot]);
    }
  }

  return Array.from(groups.entries()).map(([lotId, lots]) => {
    const first = lots[0];
    for (const lot of lots.slice(1)) {
      if (!immutableFieldsMatch(first, lot)) {
        throw new IntegrityConflictError(
          `Lot ID ${lotId} has conflicting immutable fields across physical rows`
        );
      }
    }
    // Use the last physical row's remaining_qty as the canonical value.
    const lastRemainingQty = lots[lots.length - 1].remaining_qty;
    return { ...first, remaining_qty: lastRemainingQty };
  });
}

export interface EnsureResult<T> {
  value: T;
  outcome: 'created' | 'existing';
}

/**
 * Ensures a lot exists with the caller-supplied lot_id and immutable fields.
 *
 * Algorithm (read → match → if absent: append → re-read → return):
 *  1. Read canonical lots.
 *  2. If a lot with the same lot_id exists:
 *     - Immutable fields agree → return existing, outcome='existing'.
 *     - Any immutable field differs → throw IntegrityConflictError.
 *  3. Append the caller-supplied lot row.
 *  4. Re-read canonical lots. If the lot is still not visible → throw
 *     RetryableMutationError (Sheets visibility lag).
 *  5. Return the newly appended lot, outcome='created'.
 */
export async function ensureLot(expected: Lot): Promise<EnsureResult<Lot>> {
  const existing = (await getCanonicalLots()).find(
    (l) => l.lot_id === expected.lot_id
  );

  if (existing) {
    if (!immutableFieldsMatch(existing, expected)) {
      throw new IntegrityConflictError(
        `Lot ID ${expected.lot_id} exists with conflicting immutable fields`
      );
    }
    return { value: existing, outcome: 'existing' };
  }

  await appendRow(TAB, lotToRow(expected));

  const created = (await getCanonicalLots()).find(
    (l) => l.lot_id === expected.lot_id
  );
  if (!created) {
    throw new RetryableMutationError(
      `Lot ${expected.lot_id} was not visible after append`
    );
  }

  return { value: created, outcome: 'created' };
}

/**
 * Overwrites remaining_qty on EVERY physical row sharing the given lot_id.
 *
 * This is used by reconcileLotBalance to repair the denormalized remaining_qty
 * after FIFO outflows are posted to the transaction ledger.
 *
 * Throws if no rows match (the lot does not exist).
 */
export async function setLotRemainingById(
  lotId: string,
  newRemainingQty: number
): Promise<void> {
  const rows = await getRows(TAB);
  const matchingIndices: number[] = [];

  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === lotId) {
      matchingIndices.push(i);
    }
  }

  if (matchingIndices.length === 0) {
    throw new Error(`setLotRemainingById: no rows found for lot_id ${lotId}`);
  }

  for (const rowIndex of matchingIndices) {
    const lot = rowToLot(rows[rowIndex]);
    lot.remaining_qty = newRemainingQty;
    // rowIndex is 0-based among data rows; updateRow expects a 1-based data index.
    await updateRow(TAB, rowIndex + 1, lotToRow(lot));
  }
}

/**
 * Creates a new lot with a random UUID. Kept for backward compatibility with
 * non-retry-safe paths (shipTransfer's old receiveTransfer path).
 *
 * New retry-safe paths must use ensureLot with a deterministic lot_id instead.
 *
 * @deprecated Use ensureLot with a caller-supplied deterministic ID.
 */
export async function createLot(data: Omit<Lot, 'lot_id'>): Promise<Lot> {
  const { randomUUID } = await import('node:crypto');
  const lot: Lot = { lot_id: randomUUID(), ...data };
  await appendRow(TAB, lotToRow(lot));
  return lot;
}

// NOTE: Sheets is not transactional. Concurrent calls to setLotRemainingById
// on the same lot can race (read-modify-write). The inventory service must
// serialize lot mutations via its in-process mutex.
/**
 * Updates the remaining_qty for an existing lot.
 * Reads all lots to find the 1-based row index, then updates that row in place.
 *
 * @deprecated Use setLotRemainingById for deterministic multi-row updates.
 */
export async function updateLot(
  id: string,
  remainingQty: number
): Promise<void> {
  const rows = await getRows(TAB);
  const rowIndex = rows.findIndex((r) => r[0] === id);
  if (rowIndex === -1) {
    throw new Error(`Lot not found: ${id}`);
  }

  const lot = rowToLot(rows[rowIndex]);
  lot.remaining_qty = remainingQty;

  // rowIndex is 0-based among data rows; updateRow expects a 1-based data index.
  await updateRow(TAB, rowIndex + 1, lotToRow(lot));
}
