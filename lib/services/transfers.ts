import 'server-only';

/**
 * transfers.ts — the single path through which transfer state is advanced.
 *
 * Transfer state machine (from shared-core-spec.md §4):
 *   requested → approved → in_transit → received
 *
 * Invariants enforced (CLAUDE.md):
 *  #1 (append-only): all inventory mutations go through consumeFIFO or
 *     postTransaction; the Transactions tab is never edited.
 *  #2 (FIFO always): shipTransfer calls consumeFIFO per line.
 *  #3 (transfers balance): shipTransfer posts transfer_out at source;
 *     receiveTransfer posts transfer_in at destination, recreating lots
 *     that carry the source unit_cost. Stock in transit is counted at
 *     neither location until receiveTransfer completes.
 *  #4 (base units): quantities are stored in base units; no conversion here.
 *  #5 (access scoped): location access is checked before each state advance.
 */

import {
  getAllTransfers,
  getAllTransferLines,
  createTransfer,
  createTransferLine,
  updateTransfer,
} from '../data/transfers';
import { createLot, getAllLots } from '../data/lots';
import { getAllTransactions } from '../data/transactions';
import { consumeFIFO, postTransaction } from './inventory';
import type {
  InventoryTransaction,
  Transfer,
  TransferLine,
  Session,
} from '../types';
import { Role } from '../types';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from './errors';

// ─── Input type ───────────────────────────────────────────────────────────────

export interface RequestTransferInput {
  fromLocationId: string;
  toLocationId: string;
  lines: { itemId: string; qty: number; unit: string }[];
}

// ─── Date helper ─────────────────────────────────────────────────────────────

const todayIso = () => new Date().toISOString().slice(0, 10);

// ─── receiveTransfer mutex ────────────────────────────────────────────────────
// Prevents concurrent receiveTransfer calls for the same transferId from
// racing past the idempotency guard and writing duplicate lots/transactions.

const receiveMutexMap = new Map<string, Promise<void>>();
function withReceiveMutex<T>(transferId: string, fn: () => Promise<T>): Promise<T> {
  const prev = receiveMutexMap.get(transferId) ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>(r => { resolve = r; });
  receiveMutexMap.set(transferId, next);
  return prev.then(fn).finally(() => { resolve(); receiveMutexMap.delete(transferId); });
}

// ─── Access-control helpers ───────────────────────────────────────────────────

function requireLocationAccess(session: Session, locationId: string): void {
  if (session.assignedLocationIds === 'all') return;
  if (!session.assignedLocationIds.includes(locationId)) {
    throw new ForbiddenError(
      'Access denied: location not in your assigned locations'
    );
  }
}

function requireRole(session: Session, roles: Role[]): void {
  if (!roles.includes(session.role)) {
    throw new ForbiddenError(
      `Forbidden: role '${session.role}' is not permitted for this operation`
    );
  }
}

function requireTransferAccess(session: Session, transfer: Transfer): void {
  requireLocationAccess(session, transfer.from_location_id);
  requireLocationAccess(session, transfer.to_location_id);
}

/**
 * Ship authorization: session must have access to the SOURCE location.
 * A warehouse worker assigned only to the source warehouse can ship to any
 * destination — they don't need to be assigned to the destination.
 */
function requireShipAccess(session: Session, transfer: Transfer): void {
  requireLocationAccess(session, transfer.from_location_id);
}

/**
 * Receive authorization: session must have access to the DESTINATION location.
 * A kitchen manager assigned only to the destination can receive — they don't
 * need to be assigned to the source warehouse.
 */
function requireReceiveAccess(session: Session, transfer: Transfer): void {
  requireLocationAccess(session, transfer.to_location_id);
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateRequestInput(input: RequestTransferInput): void {
  if (!input.fromLocationId || !input.fromLocationId.trim()) {
    throw new ValidationError('fromLocationId must be non-empty');
  }
  if (input.fromLocationId.length > 100) {
    throw new ValidationError('fromLocationId exceeds max length');
  }
  if (!input.toLocationId || !input.toLocationId.trim()) {
    throw new ValidationError('toLocationId must be non-empty');
  }
  if (input.toLocationId.length > 100) {
    throw new ValidationError('toLocationId exceeds max length');
  }
  // same-location transfers are nonsensical and likely a caller bug.
  if (input.fromLocationId === input.toLocationId) {
    throw new ValidationError(
      'fromLocationId and toLocationId must be different'
    );
  }
  if (!input.lines || input.lines.length === 0) {
    throw new ValidationError('lines must be non-empty');
  }
  for (let i = 0; i < input.lines.length; i++) {
    const line = input.lines[i];
    if (!line.itemId || !line.itemId.trim()) {
      throw new ValidationError(`line ${i}: itemId must be non-empty`);
    }
    if (line.itemId.length > 100) {
      throw new ValidationError(`line ${i}: itemId exceeds max length`);
    }
    if (!Number.isFinite(line.qty) || line.qty <= 0) {
      throw new ValidationError(
        `line ${i}: qty must be a positive number (got ${line.qty})`
      );
    }
    // Fix 3: qty is used directly in consumeFIFO — it MUST already be in the
    // item's base_unit. Unit conversion is deferred to a later phase.
    // The unit field is stored for display only; no conversion is applied here.
    if (!line.unit || !line.unit.trim()) {
      throw new ValidationError(`line ${i}: unit must be non-empty`);
    }
    if (line.unit.length > 50) {
      throw new ValidationError(`line ${i}: unit exceeds max length (50)`);
    }
  }
}

// ─── Load helpers ─────────────────────────────────────────────────────────────

async function loadTransfer(transferId: string): Promise<Transfer> {
  const transfers = await getAllTransfers();
  const transfer = transfers.find((t) => t.transfer_id === transferId);
  if (!transfer) {
    throw new NotFoundError(`Transfer not found: ${transferId}`);
  }
  return transfer;
}

async function loadTransferLines(transferId: string): Promise<TransferLine[]> {
  const allLines = await getAllTransferLines();
  return allLines.filter((l) => l.transfer_id === transferId);
}

const SOURCE_LOT_NOTE_PREFIX = 'source_lot:';

function sourceLotNote(lotId: string): string {
  return `${SOURCE_LOT_NOTE_PREFIX}${lotId}`;
}

function sourceLotFromNote(note?: string): string | undefined {
  if (!note?.startsWith(SOURCE_LOT_NOTE_PREFIX)) return undefined;
  return note.slice(SOURCE_LOT_NOTE_PREFIX.length);
}

function inboundMatchesOutbound(
  inbound: InventoryTransaction,
  outbound: InventoryTransaction
): boolean {
  if (
    inbound.item_id !== outbound.item_id ||
    inbound.qty_base !== Math.abs(outbound.qty_base) ||
    inbound.unit_cost !== outbound.unit_cost
  ) {
    return false;
  }

  const inboundSourceLot = sourceLotFromNote(inbound.note);
  return (
    !inboundSourceLot ||
    !outbound.lot_id ||
    inboundSourceLot === outbound.lot_id
  );
}

// ─── requestTransfer ──────────────────────────────────────────────────────────

/**
 * Creates a new transfer request.
 *
 * Steps:
 *  1. Validate inputs — throws before any writes on bad data.
 *  2. Access check — session must have access to fromLocationId (the source).
 *  3. Create the Transfer header with status='requested'.
 *  4. Create each TransferLine.
 *  5. Return the Transfer.
 */
export async function requestTransfer(
  input: RequestTransferInput,
  session: Session
): Promise<Transfer> {
  // 1. Validate before any writes.
  validateRequestInput(input);

  // 2. Access check — requests expose and move stock across both endpoints.
  requireLocationAccess(session, input.fromLocationId);
  requireLocationAccess(session, input.toLocationId);

  const today = todayIso();

  // 3. Create the Transfer header.
  const transfer = await createTransfer({
    from_location_id: input.fromLocationId,
    to_location_id: input.toLocationId,
    status: 'requested',
    requested_by: session.userId,
    request_date: today,
  });

  // 4. Create each TransferLine.
  for (const line of input.lines) {
    await createTransferLine({
      transfer_id: transfer.transfer_id,
      item_id: line.itemId,
      qty: line.qty,
      unit: line.unit,
    });
  }

  // 5. Return the Transfer.
  return transfer;
}

// ─── approveTransfer ──────────────────────────────────────────────────────────

/**
 * Advances a transfer from 'requested' to 'approved'.
 *
 * Only director_admin may approve. No inventory is written here — approval is
 * an administrative gate before stock actually moves.
 *
 * Steps:
 *  1. Load transfer; throw if not found or status !== 'requested'.
 *  2. Role check — only director_admin may approve.
 *  3. Update status → 'approved', approved_by → session.userId.
 *  4. Return updated Transfer.
 */
export async function approveTransfer(
  transferId: string,
  session: Session
): Promise<Transfer> {
  // 1. Load, authorize both endpoints, then status-gate.
  const transfer = await loadTransfer(transferId);
  requireRole(session, [Role.director_admin]);
  requireTransferAccess(session, transfer);

  if (transfer.status !== 'requested') {
    throw new ValidationError(
      `Cannot approve transfer with status '${transfer.status}': must be 'requested'`
    );
  }

  // 2. Advance status.
  return updateTransfer(transferId, {
    status: 'approved',
    approved_by: session.userId,
  });
}

// ─── shipTransfer ─────────────────────────────────────────────────────────────

/**
 * Advances a transfer from 'approved' to 'in_transit' and consumes stock at
 * the source location via FIFO.
 *
 * This is the critical step that satisfies CLAUDE.md Invariant #3 (first half):
 * stock leaves the source ledger as transfer_out; it is not yet at the
 * destination. The "in transit" gap is visible in the transfer status.
 *
 * Steps:
 *  1. Load transfer; throw if status !== 'approved'.
 *  2. Access check — session must have access to transfer.from_location_id.
 *  3. For each TransferLine, call consumeFIFO (transfer_out, ref=transferId).
 *  4. Update transfer: status → 'in_transit', ship_date → today.
 *  5. Return updated Transfer.
 *
 * Note: the lot breakdown returned by consumeFIFO is not used here — the
 * transfer_out transactions written by consumeFIFO are the permanent record.
 * receiveTransfer queries those transactions to reconstruct costs.
 */
export async function shipTransfer(
  transferId: string,
  session: Session
): Promise<Transfer> {
  // 1. Load the transfer.
  const transfer = await loadTransfer(transferId);
  // Role gate: only director_admin and warehouse may ship.
  requireRole(session, [Role.director_admin, Role.warehouse]);
  // Location gate: only source access is required to ship (Task 8).
  // director_admin may still need both-endpoint access for oversight — but
  // the warehouse worker only needs access to the source they are picking from.
  requireShipAccess(session, transfer);

  // 2. Status-gate after authorization.
  if (transfer.status !== 'approved') {
    throw new ValidationError(
      `Cannot ship transfer with status '${transfer.status}': must be 'approved'`
    );
  }

  // 3. Preflight every line before any FIFO mutation. Aggregate repeated item
  //    lines so individually valid lines cannot overdraw the same stock pool.
  const lines = await loadTransferLines(transferId);
  if (lines.length === 0) {
    throw new ValidationError('Transfer has no lines to ship');
  }

  const requiredByItem = new Map<string, number>();
  for (const line of lines) {
    requiredByItem.set(
      line.item_id,
      (requiredByItem.get(line.item_id) ?? 0) + line.qty
    );
  }

  const lots = await getAllLots();
  const availableByItem = new Map<string, number>();
  for (const lot of lots) {
    if (
      lot.location_id === transfer.from_location_id &&
      lot.remaining_qty > 0 &&
      requiredByItem.has(lot.item_id)
    ) {
      availableByItem.set(
        lot.item_id,
        (availableByItem.get(lot.item_id) ?? 0) + lot.remaining_qty
      );
    }
  }

  for (const [itemId, requiredQty] of requiredByItem) {
    const availableQty = availableByItem.get(itemId) ?? 0;
    if (availableQty < requiredQty) {
      throw new ValidationError(
        `Insufficient stock for item ${itemId} at location ` +
          `${transfer.from_location_id}: requested ${requiredQty}, ` +
          `available ${availableQty}`
      );
    }
  }

  // 4. All lines passed preflight; consume stock at source via FIFO.
  for (const line of lines) {
    await consumeFIFO({
      itemId: line.item_id,
      locationId: transfer.from_location_id,
      qty: line.qty,
      txnType: 'transfer_out',
      refType: 'transfer',
      refId: transferId,
      session,
    });
  }

  // 5. Advance status.
  return updateTransfer(transferId, {
    status: 'in_transit',
    ship_date: todayIso(),
  });
}

// ─── receiveTransfer ──────────────────────────────────────────────────────────

/**
 * Advances a transfer from 'in_transit' to 'received' and creates inventory
 * at the destination location.
 *
 * This completes CLAUDE.md Invariant #3 (second half): for each portion
 * consumed at the source, a new Lot is created at the destination carrying the
 * original unit_cost, and a transfer_in transaction is posted. After this
 * function returns, stock is counted at the destination and not at the source.
 *
 * Steps:
 *  1. Load transfer; throw if status !== 'in_transit'.
 *  2. Access check — session must have access to transfer.to_location_id.
 *  3. Query all transfer_out transactions for this transferId to reconstruct
 *     the (lot_id, qty, unit_cost) breakdown produced by shipTransfer.
 *  4. For each consumed-lot portion:
 *     a. Create a new Lot at destination (source_ref = transferId, cost carried).
 *     b. Post a transfer_in transaction for the new lot.
 *  5. Update transfer: status → 'received', received_by, receive_date → today.
 *  6. Return updated Transfer.
 */
export async function receiveTransfer(
  transferId: string,
  session: Session
): Promise<Transfer> {
  return withReceiveMutex(transferId, async () => {
    // 1. Load the transfer.
    const transfer = await loadTransfer(transferId);
    // Role gate: director_admin, warehouse, and kitchen_manager may receive.
    requireRole(session, [
      Role.director_admin,
      Role.warehouse,
      Role.kitchen_manager,
    ]);
    // Location gate: only destination access is required to receive (Task 9).
    // A kitchen manager assigned only to the destination can receive without
    // needing access to the source warehouse.
    requireReceiveAccess(session, transfer);

    // 2. Status-gate after authorization.
    if (transfer.status !== 'in_transit') {
      throw new ValidationError(
        `Cannot receive transfer with status '${transfer.status}': must be 'in_transit'`
      );
    }

    const allTxns = await getAllTransactions();

    // 3. Find all transfer_out transactions written by shipTransfer for this
    //    transfer. Each row represents one lot portion consumed at the source,
    //    with the original unit_cost recorded on the transaction (per FIFO rule).
    //    qty_base on transfer_out rows is negative; we take Math.abs for the lot.
    const outboundTxns = allTxns.filter(
      (t) =>
        t.txn_type === 'transfer_out' &&
        t.ref_type === 'transfer' &&
        t.ref_id === transferId
    );
    if (outboundTxns.length === 0) {
      throw new ValidationError(
        `Transfer ${transferId} has no transfer_out transactions`
      );
    }

    const existingInbound = allTxns.filter(
      (t) =>
        t.txn_type === 'transfer_in' &&
        t.ref_type === 'transfer' &&
        t.ref_id === transferId &&
        t.location_id === transfer.to_location_id
    );
    const unmatchedInbound = [...existingInbound];
    const missingOutbound = outboundTxns.filter((outbound) => {
      const matchIndex = unmatchedInbound.findIndex((inbound) =>
        inboundMatchesOutbound(inbound, outbound)
      );
      if (matchIndex === -1) return true;
      unmatchedInbound.splice(matchIndex, 1);
      return false;
    });
    if (unmatchedInbound.length > 0) {
      throw new ValidationError(
        `Cannot reconcile transfer ${transferId}: unexpected transfer_in portions`
      );
    }

    const today = todayIso();

    // 4. Recreate only portions not already represented by transfer_in rows.
    for (const txn of missingOutbound) {
      const consumedQty = Math.abs(txn.qty_base); // qty_base is negative for outflows

      // 4a. Create a new Lot at the destination.
      //     The lot carries the source unit_cost (invariant: cost is preserved
      //     across transfers). source_ref links back to the transfer for audit.
      const newLot = await createLot({
        item_id: txn.item_id,
        location_id: transfer.to_location_id,
        received_date: today,
        original_qty: consumedQty,
        remaining_qty: consumedQty,
        unit_cost: txn.unit_cost,
        source_ref: transferId,
      });

      // 4b. Post a transfer_in transaction for the new destination lot.
      //     postTransaction validates sign (transfer_in must be positive) and
      //     access (session must include to_location_id).
      await postTransaction(
        {
          item_id: txn.item_id,
          location_id: transfer.to_location_id,
          lot_id: newLot.lot_id,
          qty_base: consumedQty,          // positive inflow
          txn_type: 'transfer_in',
          ref_type: 'transfer',
          ref_id: transferId,
          unit_cost: txn.unit_cost,       // source cost preserved
          note: txn.lot_id ? sourceLotNote(txn.lot_id) : undefined,
        },
        session
      );
    }

    // 5. Advance status.
    return updateTransfer(transferId, {
      status: 'received',
      received_by: session.userId,
      receive_date: today,
    });
  });
}
