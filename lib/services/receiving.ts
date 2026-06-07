import 'server-only';

/**
 * receiving.ts — the single path through which inbound goods are recorded.
 *
 * Three inbound paths from the spec (§4):
 *   1. Vendor → warehouse
 *   2. Vendor → building (direct delivery)
 *   3. Warehouse → building via Transfer (Transfer.receive calls this path
 *      with a transfer_id as `source`; that wiring is done in the transfers
 *      service when that phase is built)
 *
 * For every received line this service:
 *   a. Creates a Receipt header (once, shared across all lines)
 *   b. Creates a ReceiptLine record
 *   c. Creates a Lot (FIFO cost layer) with today as received_date
 *   d. Posts a `receive` transaction via postTransaction (inflow, positive qty)
 *
 * Architecture invariants honoured:
 *   - All Sheets I/O flows through lib/data/ only.
 *   - All inventory mutations flow through lib/services/inventory.ts.
 *   - The Transactions tab is append-only (postTransaction calls appendTransaction).
 *   - Quantities are stored in base units; the caller is responsible for unit
 *     conversion at the boundary (unit conversion is deferred per task spec).
 *   - Access is scoped via Session.assignedLocationIds.
 */

import {
  createReceipt,
  createReceiptLine,
  ensureReceipt,
  ensureReceiptLine,
  getReceiptLines,
} from '../data/receipts';
import { createLot } from '../data/lots';
import { postTransaction, ensureInboundPortion } from './inventory';
import { deterministicId } from './deterministicIds';
import type { Receipt, Session } from '../types';
import { ForbiddenError, ValidationError, IdempotencyConflictError } from './errors';

// ─── Input type ───────────────────────────────────────────────────────────────

export interface ReceiveDeliveryLine {
  itemId: string;
  qtyReceived: number;
  unit: string;
  unitCost: number;
  expirationDate?: string; // ISO date string, optional
}

export interface ReceiveDeliveryInput {
  orderId?: string;     // undefined = blind receive
  source: string;       // vendor_id OR transfer_id
  locationId: string;   // where goods are being received
  lines: ReceiveDeliveryLine[];
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validate(input: ReceiveDeliveryInput): void {
  if (!input.locationId || !input.locationId.trim()) {
    throw new ValidationError('locationId must be non-empty');
  }
  if (!input.source || typeof input.source !== 'string' || input.source.trim().length === 0) {
    throw new ValidationError('source must be a non-empty string');
  }
  if (input.source.length > 200) {
    throw new ValidationError('source exceeds max length');
  }
  if (input.orderId !== undefined && (typeof input.orderId !== 'string' || input.orderId.length > 200)) {
    throw new ValidationError('orderId must be a string under 200 chars');
  }
  if (!input.lines || input.lines.length === 0) {
    throw new ValidationError('lines must be non-empty');
  }
  for (let i = 0; i < input.lines.length; i++) {
    const line = input.lines[i];
    if (!line.itemId || !line.itemId.trim()) {
      throw new ValidationError('each line must have a non-empty itemId');
    }
    if (!Number.isFinite(line.qtyReceived) || line.qtyReceived <= 0) {
      throw new ValidationError(
        `qtyReceived must be a positive number (got ${line.qtyReceived} for item ${line.itemId})`
      );
    }
    if (!Number.isFinite(line.unitCost) || line.unitCost < 0) {
      throw new ValidationError(
        `unitCost must be a non-negative number (got ${line.unitCost} for item ${line.itemId})`
      );
    }
    if (!line.unit || typeof line.unit !== 'string' || line.unit.trim().length === 0) {
      throw new ValidationError(`line ${i}: unit must be a non-empty string`);
    }
    if (line.unit.length > 50) {
      throw new ValidationError(`line ${i}: unit exceeds max length`);
    }
    if (line.expirationDate !== undefined) {
      if (typeof line.expirationDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(line.expirationDate)) {
        throw new ValidationError(
          `line ${i}: expirationDate must be ISO date (YYYY-MM-DD)`
        );
      }
    }
  }
}

// ─── receiveDelivery ──────────────────────────────────────────────────────────

/**
 * Records an inbound delivery.
 *
 * Steps:
 *  1. Validate inputs — throws before any writes on bad data.
 *  2. Access check — session must include locationId (or be 'all').
 *  3. Create a Receipt header row.
 *  4. For each line:
 *     a. Create a ReceiptLine row.
 *     b. Create a Lot (opens the FIFO cost layer).
 *     c. Post a `receive` transaction (positive inflow to the ledger).
 *  5. Return the Receipt.
 */
export async function receiveDelivery(
  input: ReceiveDeliveryInput,
  session: Session
): Promise<Receipt> {
  // 1. Validate before any writes.
  validate(input);

  // 2. Access check — mirrors the guard inside inventory service functions.
  //    Done here so the error is raised before we write the Receipt header.
  if (session.assignedLocationIds !== 'all') {
    if (!session.assignedLocationIds.includes(input.locationId)) {
      throw new ForbiddenError(
        'Access denied: location not in your assigned locations'
      );
    }
  }

  // Today in ISO format (YYYY-MM-DD).  Used as received_date for every lot
  // created in this delivery.
  const today = new Date().toISOString().slice(0, 10);

  // 3. Create the Receipt header.
  const receipt = await createReceipt({
    order_id: input.orderId,
    source: input.source,
    location_id: input.locationId,
    receipt_date: today,
    received_by: session.userId,
  });

  // 4. Process each line.
  for (const line of input.lines) {
    // 4a. Persist the ReceiptLine.
    await createReceiptLine({
      receipt_id: receipt.receipt_id,
      item_id: line.itemId,
      qty_received: line.qtyReceived,
      unit: line.unit,
      unit_cost: line.unitCost,
      expiration_date: line.expirationDate,
    });

    // 4b. Create the Lot (FIFO cost layer).
    //     originalQty and remainingQty are set to qtyReceived because the
    //     goods just arrived — nothing has been consumed yet.
    //     Unit conversion is deferred: caller must pass qty already in base units.
    const lot = await createLot({
      item_id: line.itemId,
      location_id: input.locationId,
      received_date: today,
      expiration_date: line.expirationDate,
      original_qty: line.qtyReceived,
      remaining_qty: line.qtyReceived,
      unit_cost: line.unitCost,
      source_ref: receipt.receipt_id,
    });

    // 4c. Post the receive transaction (positive inflow).
    //     postTransaction handles its own access check and sign validation.
    await postTransaction(
      {
        item_id: line.itemId,
        location_id: input.locationId,
        lot_id: lot.lot_id,
        qty_base: line.qtyReceived,
        txn_type: 'receive',
        ref_type: 'receipt',
        ref_id: receipt.receipt_id,
        unit_cost: line.unitCost,
      },
      session
    );
  }

  // 5. Return the created Receipt.
  return receipt;
}

// ─── receiveManifest ─────────────────────────────────────────────────────────

/** Pattern for a deterministic receipt ID: rcpt:v1:<UUID>. */
const RECEIPT_ID_PATTERN = /^rcpt:v1:[0-9a-fA-F-]{36}$/;

export interface ReceiveManifestLine {
  itemId: string;
  qtyReceived: number;
  unit: string;
  unitCost: number;
  expirationDate?: string;
}

export interface ReceiveManifestInput {
  /** Deterministic receipt ID supplied by the caller. Must match ^rcpt:v1:[UUID]$ */
  receiptId: string;
  orderId?: string;
  source: string;
  locationId: string;
  lines: ReceiveManifestLine[];
}

export interface ReceiveManifestResult {
  receipt: Receipt;
  /** 'created' when the receipt header was newly written; 'existing' on retry. */
  outcome: 'created' | 'existing';
}

/**
 * Retry-safe receipt manifest reconciliation.
 *
 * All artifact IDs are deterministic so every step is idempotent:
 *   lineId = deterministicId('rline:v1', [receiptId, String(i)])
 *   lotId  = deterministicId('lot:recv:v1', [receiptId, lineId])
 *   txnId  = deterministicId('txn:recv:v1', [receiptId, lineId])
 *
 * Steps:
 *  1. Validate receiptId format.
 *  2. Access check.
 *  3. ensureReceipt — idempotent header.
 *  4. getReceiptLines — compare against expected manifest; reject unexpected lines.
 *  5. For each expected line: ensureReceiptLine, then ensureInboundPortion.
 */
export async function receiveManifest(
  input: ReceiveManifestInput,
  session: Session
): Promise<ReceiveManifestResult> {
  // 1. Validate receiptId format.
  if (!input.receiptId || !RECEIPT_ID_PATTERN.test(input.receiptId)) {
    throw new ValidationError(
      `receiptId must match ^rcpt:v1:[UUID]$ (got: "${input.receiptId ?? ''}")`
    );
  }

  // Reuse the same input validation as receiveDelivery.
  validate({
    locationId: input.locationId,
    source: input.source,
    lines: input.lines.map((l) => ({
      itemId: l.itemId,
      qtyReceived: l.qtyReceived,
      unit: l.unit,
      unitCost: l.unitCost,
      expirationDate: l.expirationDate,
    })),
  });

  // 2. Access check.
  if (session.assignedLocationIds !== 'all') {
    if (!session.assignedLocationIds.includes(input.locationId)) {
      throw new ForbiddenError(
        'Access denied: location not in your assigned locations'
      );
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  // 3. Ensure the receipt header.
  const { value: receipt, outcome } = await ensureReceipt({
    receipt_id: input.receiptId,
    order_id: input.orderId,
    source: input.source,
    location_id: input.locationId,
    receipt_date: today,
    received_by: session.userId,
  });

  // 4. Build the expected manifest and check for unexpected stored lines.
  const expectedLineIds = new Set(
    input.lines.map((_, i) =>
      deterministicId('rline:v1', [input.receiptId, String(i)])
    )
  );

  const storedLines = await getReceiptLines(input.receiptId);
  for (const stored of storedLines) {
    if (!expectedLineIds.has(stored.line_id)) {
      throw new IdempotencyConflictError(
        `Receipt ${input.receiptId} has unexpected stored line ${stored.line_id} ` +
          `that is not in the submitted manifest`
      );
    }
  }

  // 5. Ensure each expected line and its inventory artifacts.
  for (let i = 0; i < input.lines.length; i++) {
    const line = input.lines[i];
    const lineId = deterministicId('rline:v1', [input.receiptId, String(i)]);
    const lotId = deterministicId('lot:recv:v1', [input.receiptId, lineId]);
    const txnId = deterministicId('txn:recv:v1', [input.receiptId, lineId]);

    await ensureReceiptLine({
      line_id: lineId,
      receipt_id: input.receiptId,
      item_id: line.itemId,
      qty_received: line.qtyReceived,
      unit: line.unit,
      unit_cost: line.unitCost,
      expiration_date: line.expirationDate,
    });

    await ensureInboundPortion({
      lot: {
        lot_id: lotId,
        item_id: line.itemId,
        location_id: input.locationId,
        received_date: today,
        expiration_date: line.expirationDate,
        original_qty: line.qtyReceived,
        remaining_qty: line.qtyReceived,
        unit_cost: line.unitCost,
        source_ref: input.receiptId,
      },
      transaction: {
        txn_id: txnId,
        item_id: line.itemId,
        location_id: input.locationId,
        lot_id: lotId,
        qty_base: line.qtyReceived,
        txn_type: 'receive',
        ref_type: 'receipt',
        ref_id: input.receiptId,
        unit_cost: line.unitCost,
        user_id: session.userId,
      },
      session,
    });
  }

  return { receipt, outcome };
}
