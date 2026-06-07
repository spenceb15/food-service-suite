import 'server-only';

import { randomUUID } from 'node:crypto';
import { getRows, appendRow, updateRow } from './sheets';
import { parseNum, parseEnum } from '../types';
import type { Transfer, TransferLine, TransferStatus } from '../types';

// Transfers tab column order (0-based):
// transfer_id, from_location_id, to_location_id, status, requested_by,
// approved_by, received_by, request_date, ship_date, receive_date

// TransferLines tab column order (0-based):
// line_id, transfer_id, item_id, qty, unit

const TRANSFERS_TAB = 'Transfers';
const LINES_TAB = 'TransferLines';

const TRANSFER_STATUSES: readonly TransferStatus[] = [
  'requested',
  'approved',
  'in_transit',
  'received',
  'cancelled',
];

// ─── Transfers ────────────────────────────────────────────────────────────────

function rowToTransfer(row: string[]): Transfer {
  // status is load-bearing for the transfer state machine — throw on invalid values.
  const status = parseEnum(row[3], TRANSFER_STATUSES, 'transfer status');

  return {
    transfer_id: row[0] ?? '',
    from_location_id: row[1] ?? '',
    to_location_id: row[2] ?? '',
    status,
    requested_by: row[4] ?? '',
    approved_by: (row[5] ?? '') !== '' ? row[5] : undefined,
    received_by: (row[6] ?? '') !== '' ? row[6] : undefined,
    request_date: row[7] ?? '',
    ship_date: (row[8] ?? '') !== '' ? row[8] : undefined,
    receive_date: (row[9] ?? '') !== '' ? row[9] : undefined,
  };
}

function transferToRow(transfer: Transfer): unknown[] {
  return [
    transfer.transfer_id,
    transfer.from_location_id,
    transfer.to_location_id,
    transfer.status,
    transfer.requested_by,
    transfer.approved_by ?? '',
    transfer.received_by ?? '',
    transfer.request_date,
    transfer.ship_date ?? '',
    transfer.receive_date ?? '',
  ];
}

export { rowToTransfer, transferToRow };

export async function getAllTransfers(): Promise<Transfer[]> {
  const rows = await getRows(TRANSFERS_TAB);
  return rows.filter((r) => r[0] !== '').map(rowToTransfer);
}

export async function createTransfer(
  data: Omit<Transfer, 'transfer_id'>
): Promise<Transfer> {
  const transfer: Transfer = { transfer_id: randomUUID(), ...data };
  await appendRow(TRANSFERS_TAB, transferToRow(transfer));
  return transfer;
}

// NOTE: Sheets is not transactional. Concurrent calls to updateTransfer on the same transfer
// can race (read-modify-write). The inventory service must serialize transfer mutations.
/**
 * Updates a transfer row in place (e.g. to advance status, set ship_date or
 * receive_date). Reads the tab to locate the row, then overwrites it.
 */
export async function updateTransfer(
  id: string,
  updates: Partial<Omit<Transfer, 'transfer_id'>>
): Promise<Transfer> {
  const rows = await getRows(TRANSFERS_TAB);
  const rowIndex = rows.findIndex((r) => r[0] === id);
  if (rowIndex === -1) {
    throw new Error(`Transfer not found: ${id}`);
  }

  const existing = rowToTransfer(rows[rowIndex]);
  const updated: Transfer = { ...existing, ...updates };

  // rowIndex is 0-based among data rows; updateRow expects a 1-based data index.
  await updateRow(TRANSFERS_TAB, rowIndex + 1, transferToRow(updated));
  return updated;
}

// ─── TransferLines ────────────────────────────────────────────────────────────

function rowToTransferLine(row: string[]): TransferLine {
  return {
    line_id: row[0] ?? '',
    transfer_id: row[1] ?? '',
    item_id: row[2] ?? '',
    qty: parseNum(row[3]),
    unit: row[4] ?? '',
  };
}

function transferLineToRow(line: TransferLine): unknown[] {
  return [line.line_id, line.transfer_id, line.item_id, line.qty, line.unit];
}

export async function getAllTransferLines(): Promise<TransferLine[]> {
  const rows = await getRows(LINES_TAB);
  return rows.filter((r) => r[0] !== '').map(rowToTransferLine);
}

export async function createTransferLine(
  data: Omit<TransferLine, 'line_id'>
): Promise<TransferLine> {
  const line: TransferLine = { line_id: randomUUID(), ...data };
  await appendRow(LINES_TAB, transferLineToRow(line));
  return line;
}
