import 'server-only';

import { randomUUID } from 'node:crypto';
import { getRows, appendRow } from './sheets';
import { parseNum } from '../types';
import {
  IdempotencyConflictError,
  RetryableMutationError,
} from '../services/errors';
import { normalizeLedgerNumber } from '../services/deterministicIds';
import type { Receipt, ReceiptLine } from '../types';

// Receipts tab column order (0-based):
// receipt_id, order_id, source, location_id, receipt_date, received_by

// ReceiptLines tab column order (0-based):
// line_id, receipt_id, item_id, qty_received, unit, unit_cost, expiration_date

const RECEIPTS_TAB = 'Receipts';
const LINES_TAB = 'ReceiptLines';

// ─── Receipts ─────────────────────────────────────────────────────────────────

function rowToReceipt(row: string[]): Receipt {
  return {
    receipt_id: row[0] ?? '',
    order_id: (row[1] ?? '') !== '' ? row[1] : undefined,
    source: row[2] ?? '',
    location_id: row[3] ?? '',
    receipt_date: row[4] ?? '',
    received_by: row[5] ?? '',
  };
}

function receiptToRow(receipt: Receipt): unknown[] {
  return [
    receipt.receipt_id,
    receipt.order_id ?? '',
    receipt.source,
    receipt.location_id,
    receipt.receipt_date,
    receipt.received_by,
  ];
}

export { rowToReceipt, receiptToRow };

export async function getAllReceipts(): Promise<Receipt[]> {
  const rows = await getRows(RECEIPTS_TAB);
  return rows.filter((r) => r[0] !== '').map(rowToReceipt);
}

/**
 * Checks whether two receipts agree on their idempotency-keyed immutable fields.
 * source, location_id, and order_id are the fields that identify WHAT was received
 * and WHERE. receipt_date and received_by are audit stamps that are allowed to
 * differ on retry (we preserve the original).
 */
function receiptImmutableFieldsMatch(a: Receipt, b: Receipt): boolean {
  return (
    a.source === b.source &&
    a.location_id === b.location_id &&
    (a.order_id ?? '') === (b.order_id ?? '')
  );
}

/**
 * Ensures a receipt header exists with the caller-supplied receipt_id.
 * Callers must supply a deterministic receipt_id — do not use randomUUID() here.
 *
 * Algorithm: read → match → if absent: append → re-read → return.
 *  - If same receipt_id exists with matching source/location_id/order_id:
 *    return existing (preserves original receipt_date and received_by).
 *  - If same receipt_id exists with conflicting source/location_id/order_id:
 *    throw IdempotencyConflictError.
 *  - If absent: append, re-read, return outcome='created'.
 */
export async function ensureReceipt(
  expected: Receipt
): Promise<{ value: Receipt; outcome: 'created' | 'existing' }> {
  const rows = await getRows(RECEIPTS_TAB);
  const existing = rows
    .filter((r) => r[0] !== '')
    .map(rowToReceipt)
    .find((r) => r.receipt_id === expected.receipt_id);

  if (existing) {
    if (!receiptImmutableFieldsMatch(existing, expected)) {
      throw new IdempotencyConflictError(
        `Receipt ID ${expected.receipt_id} exists with conflicting payload`
      );
    }
    return { value: existing, outcome: 'existing' };
  }

  await appendRow(RECEIPTS_TAB, receiptToRow(expected));

  const afterRows = await getRows(RECEIPTS_TAB);
  const created = afterRows
    .filter((r) => r[0] !== '')
    .map(rowToReceipt)
    .find((r) => r.receipt_id === expected.receipt_id);

  if (!created) {
    throw new RetryableMutationError(
      `Receipt ${expected.receipt_id} was not visible after append`
    );
  }

  return { value: created, outcome: 'created' };
}

/**
 * @deprecated Use ensureReceipt with a deterministic caller-supplied receipt_id.
 */
export async function createReceipt(
  data: Omit<Receipt, 'receipt_id'>
): Promise<Receipt> {
  const receipt: Receipt = { receipt_id: randomUUID(), ...data };
  await appendRow(RECEIPTS_TAB, receiptToRow(receipt));
  return receipt;
}

// ─── ReceiptLines ─────────────────────────────────────────────────────────────

function rowToReceiptLine(row: string[]): ReceiptLine {
  return {
    line_id: row[0] ?? '',
    receipt_id: row[1] ?? '',
    item_id: row[2] ?? '',
    qty_received: parseNum(row[3]),
    unit: row[4] ?? '',
    unit_cost: parseNum(row[5]),
    expiration_date: (row[6] ?? '') !== '' ? row[6] : undefined,
  };
}

function receiptLineToRow(line: ReceiptLine): unknown[] {
  return [
    line.line_id,
    line.receipt_id,
    line.item_id,
    line.qty_received,
    line.unit,
    line.unit_cost,
    line.expiration_date ?? '',
  ];
}

export { rowToReceiptLine, receiptLineToRow };

export async function getAllReceiptLines(): Promise<ReceiptLine[]> {
  const rows = await getRows(LINES_TAB);
  return rows.filter((r) => r[0] !== '').map(rowToReceiptLine);
}

/**
 * Returns all receipt lines for the given receiptId.
 * Used by the receiving service to validate the manifest against expected lines.
 */
export async function getReceiptLines(receiptId: string): Promise<ReceiptLine[]> {
  const rows = await getRows(LINES_TAB);
  return rows
    .filter((r) => r[0] !== '')
    .map(rowToReceiptLine)
    .filter((l) => l.receipt_id === receiptId);
}

/**
 * Checks whether two receipt lines agree on all idempotency-keyed fields.
 * All fields except line_id itself are idempotency keys — any change means a
 * different semantic operation under the same ID.
 */
function receiptLineFieldsMatch(a: ReceiptLine, b: ReceiptLine): boolean {
  return (
    a.receipt_id === b.receipt_id &&
    a.item_id === b.item_id &&
    normalizeLedgerNumber(a.qty_received) ===
      normalizeLedgerNumber(b.qty_received) &&
    a.unit === b.unit &&
    normalizeLedgerNumber(a.unit_cost) === normalizeLedgerNumber(b.unit_cost) &&
    (a.expiration_date ?? '') === (b.expiration_date ?? '')
  );
}

/**
 * Ensures a receipt line exists with the caller-supplied line_id.
 * Callers must supply a deterministic line_id — do not use randomUUID() here.
 *
 * Algorithm: read → match → if absent: append → re-read → return.
 *  - If same line_id exists with matching fields: return existing.
 *  - If same line_id exists with conflicting fields: throw IdempotencyConflictError.
 *  - If absent: append, re-read, return outcome='created'.
 */
export async function ensureReceiptLine(
  expected: ReceiptLine
): Promise<{ value: ReceiptLine; outcome: 'created' | 'existing' }> {
  const rows = await getRows(LINES_TAB);
  const existing = rows
    .filter((r) => r[0] !== '')
    .map(rowToReceiptLine)
    .find((l) => l.line_id === expected.line_id);

  if (existing) {
    if (!receiptLineFieldsMatch(existing, expected)) {
      throw new IdempotencyConflictError(
        `Receipt line ID ${expected.line_id} exists with conflicting payload`
      );
    }
    return { value: existing, outcome: 'existing' };
  }

  await appendRow(LINES_TAB, receiptLineToRow(expected));

  const afterRows = await getRows(LINES_TAB);
  const created = afterRows
    .filter((r) => r[0] !== '')
    .map(rowToReceiptLine)
    .find((l) => l.line_id === expected.line_id);

  if (!created) {
    throw new RetryableMutationError(
      `Receipt line ${expected.line_id} was not visible after append`
    );
  }

  return { value: created, outcome: 'created' };
}

/**
 * @deprecated Use ensureReceiptLine with a deterministic caller-supplied line_id.
 */
export async function createReceiptLine(
  data: Omit<ReceiptLine, 'line_id'>
): Promise<ReceiptLine> {
  const line: ReceiptLine = { line_id: randomUUID(), ...data };
  await appendRow(LINES_TAB, receiptLineToRow(line));
  return line;
}
