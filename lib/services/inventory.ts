import 'server-only';

/**
 * inventory.ts — the ONLY path through which inventory state is changed.
 *
 * Rules (from CLAUDE.md / shared-core-spec.md):
 *  1. Transactions are append-only. Never call updateRow on transactions.
 *  2. FIFO always — oldest lot (by received_date) consumed first, no exceptions.
 *  3. qty_base in transactions is signed: negative for outflows, positive for inflows.
 *  4. consumeFIFO pre-checks available stock before any writes so a shortage
 *     never leaves the ledger in a half-consumed state.
 *  5. All quantities are in base units — no conversion happens here.
 */

import { getAllLots, updateLot, getCanonicalLots, setLotRemainingById, ensureLot } from '../data/lots';
import {
  getAllTransactions,
  appendTransaction,
  getCanonicalTransactions,
  ensureTransaction,
  type EnsureTransactionInput,
} from '../data/transactions';
import type { Lot, InventoryTransaction, TxnType, RefType, Session } from '../types';
import { Role } from '../types';
import { ForbiddenError, ValidationError, IntegrityConflictError } from './errors';
import { normalizeLedgerNumber } from './deterministicIds';

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
      `Access denied: role '${session.role}' is not permitted for this operation`
    );
  }
}

// ─── Formula-injection sanitization ──────────────────────────────────────────

const FORMULA_CHARS = new Set(['=', '+', '-', '@', '\t', '\r']);

function sanitizeNote(note?: string): string | undefined {
  if (!note) return note;
  return FORMULA_CHARS.has(note.trimStart()[0]) ? `'${note}` : note;
}

// ─── In-process async mutex ───────────────────────────────────────────────────

const mutexMap = new Map<string, Promise<void>>();

function withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = mutexMap.get(key) ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>((r) => {
    resolve = r;
  });
  mutexMap.set(key, next);
  return prev.then(fn).finally(() => {
    resolve();
    mutexMap.delete(key);
  });
}

// ─── getOnHand ────────────────────────────────────────────────────────────────

/**
 * Returns the authoritative on-hand quantity for an item at a location.
 *
 * On-hand is ALWAYS derived by summing signed qty_base across all transactions
 * for this item+location. It is never stored as an editable number (Invariant 1).
 */
export async function getOnHand(
  itemId: string,
  locationId: string,
  session: Session
): Promise<number> {
  requireLocationAccess(session, locationId);
  // Use canonical transactions to prevent duplicate rows from double-counting.
  const txns = await getCanonicalTransactions();
  return txns
    .filter((t) => t.item_id === itemId && t.location_id === locationId)
    .reduce((sum, t) => sum + t.qty_base, 0);
}

// ─── getInventoryValue ────────────────────────────────────────────────────────

/**
 * Returns the total inventory value for a location.
 *
 * Value = Σ(lot.remaining_qty × lot.unit_cost) across all lots with remaining
 * stock. This is derived from lot records, not from transaction history, which
 * is correct: lot.unit_cost carries the FIFO cost and lot.remaining_qty tracks
 * what is physically on hand in each cost layer.
 */
export async function getInventoryValue(
  locationId: string,
  session: Session
): Promise<number> {
  requireLocationAccess(session, locationId);
  // Use canonical lots so duplicate physical rows do not double-count value.
  const lots = await getCanonicalLots();
  return lots
    .filter((l) => l.location_id === locationId && l.remaining_qty > 0)
    .reduce((sum, l) => sum + l.remaining_qty * l.unit_cost, 0);
}

// ─── consumeFIFO ──────────────────────────────────────────────────────────────

export interface ConsumeFIFOParams {
  itemId: string;
  locationId: string;
  /** Quantity to consume, in base units. Must be positive. */
  qty: number;
  txnType: TxnType;
  refType: RefType;
  refId: string;
  note?: string;
  session: Session;
}

export interface LotConsumed {
  lotId: string;
  qty: number;
  unitCost: number;
}

/**
 * Consumes qty of an item from a location using FIFO lot ordering.
 *
 * Algorithm:
 *  1. Load all lots for item+location with remaining_qty > 0, sorted oldest first.
 *  2. Pre-check: sum available qty. Throw if insufficient (before any writes).
 *  3. Walk lots oldest-to-newest, decrementing remaining_qty and posting one
 *     InventoryTransaction (with NEGATIVE qty_base) per lot touched.
 *  4. Return the consumed lot breakdown for caller costing.
 *
 * The pre-check means a shortage never leaves the ledger partially consumed.
 * userId is derived from session to prevent caller spoofing.
 * An in-process mutex serializes concurrent calls for the same item+location.
 */
export async function consumeFIFO(params: ConsumeFIFOParams): Promise<{
  lotConsumed: LotConsumed[];
}> {
  const { itemId, locationId, qty, txnType, refType, refId, note, session } =
    params;

  // H3: finite + positive guard (also catches NaN)
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new ValidationError(
      `consumeFIFO: qty must be a positive finite number, got ${qty}`
    );
  }

  // H4: validate ID strings
  if (!itemId?.trim()) throw new ValidationError('itemId must be non-empty');
  if (!locationId?.trim()) {
    throw new ValidationError('locationId must be non-empty');
  }
  if (!refId?.trim()) throw new ValidationError('refId must be non-empty');

  const fifoOutflowTypes: TxnType[] = [
    'consume',
    'sell',
    'transfer_out',
    'waste',
  ];
  if (!fifoOutflowTypes.includes(txnType)) {
    throw new ValidationError(
      'consumeFIFO only supports consume, sell, transfer_out, or waste'
    );
  }

  // H1: access control (before any reads of lot data)
  requireLocationAccess(session, locationId);
  if (txnType === 'waste') {
    requireRole(session, [Role.director_admin, Role.warehouse]);
  }

  // Derive userId from session — prevents caller spoofing
  const userId = session.userId;

  return withMutex(`${itemId}|${locationId}`, async () => {
    // 1. Load eligible lots in FIFO order (oldest received_date first).
    const allLots = await getAllLots();
    const eligibleLots: Lot[] = allLots
      .filter(
        (l) =>
          l.item_id === itemId &&
          l.location_id === locationId &&
          l.remaining_qty > 0
      )
      .sort((a, b) => {
        // ISO date strings sort lexicographically, which is chronological.
        if (a.received_date < b.received_date) return -1;
        if (a.received_date > b.received_date) return 1;
        // Tie-break on lot_id for deterministic ordering.
        return a.lot_id.localeCompare(b.lot_id);
      });

    // 2. Pre-check: verify sufficient stock exists before touching anything.
    const totalAvailable = eligibleLots.reduce(
      (sum, l) => sum + l.remaining_qty,
      0
    );
    if (totalAvailable < qty) {
      throw new ValidationError(
        `Insufficient stock for item ${itemId} at location ${locationId}: ` +
          `requested ${qty}, available ${totalAvailable}`
      );
    }

    // 3. Walk lots, consuming oldest first.
    const lotConsumed: LotConsumed[] = [];
    let remaining = qty;

    for (const lot of eligibleLots) {
      if (remaining <= 0) break;

      const take = Math.min(lot.remaining_qty, remaining);
      const newRemainingQty = lot.remaining_qty - take;

      // Update lot.remaining_qty in the data layer.
      await updateLot(lot.lot_id, newRemainingQty);

      // Post one transaction per lot consumed. qty_base is NEGATIVE (outflow).
      await appendTransaction({
        item_id: itemId,
        location_id: locationId,
        lot_id: lot.lot_id,
        qty_base: -take,
        txn_type: txnType,
        ref_type: refType,
        ref_id: refId,
        unit_cost: lot.unit_cost,
        user_id: userId,
        note: sanitizeNote(note),
      });

      lotConsumed.push({
        lotId: lot.lot_id,
        qty: take,
        unitCost: lot.unit_cost,
      });

      remaining -= take;
    }

    return { lotConsumed };
  });
}

// ─── postTransaction ──────────────────────────────────────────────────────────

/**
 * Posts a single inventory transaction to the append-only ledger.
 *
 * Use this for inflows (receive, transfer_in, yield, count_adjust) and any
 * other ledger entry that does NOT require FIFO lot selection.
 * For outflows that must draw from specific lots, use consumeFIFO instead.
 *
 * txn_id and timestamp are generated by the data layer (appendTransaction)
 * so they are guaranteed unique and server-stamped.
 */
export async function postTransaction(
  txn: Omit<InventoryTransaction, 'txn_id' | 'timestamp' | 'user_id'>,
  session: Session
): Promise<InventoryTransaction> {
  // H1: access control
  requireLocationAccess(session, txn.location_id);

  // H1: role gate for sensitive txn_types
  if (txn.txn_type === 'count_adjust' || txn.txn_type === 'waste') {
    requireRole(session, [Role.director_admin, Role.warehouse]);
  }

  // H2: validate qty_base
  if (!Number.isFinite(txn.qty_base) || txn.qty_base === 0) {
    throw new ValidationError('qty_base must be a finite non-zero number');
  }

  // H2: validate unit_cost
  if (!Number.isFinite(txn.unit_cost) || txn.unit_cost < 0) {
    throw new ValidationError(
      'unit_cost must be a non-negative finite number'
    );
  }

  // H2: validate required ID fields
  for (const [field, val] of [
    ['item_id', txn.item_id],
    ['location_id', txn.location_id],
    ['ref_id', txn.ref_id],
  ] as const) {
    if (!val || !val.trim()) {
      throw new ValidationError(`${field} must be non-empty`);
    }
  }

  // H2: sign convention by txn_type
  const inflowTypes: TxnType[] = ['receive', 'transfer_in', 'yield'];
  const outflowTypes: TxnType[] = ['consume', 'sell', 'waste', 'transfer_out'];
  // count_adjust is bidirectional, so it intentionally skips sign checks.
  if (inflowTypes.includes(txn.txn_type) && txn.qty_base < 0) {
    throw new ValidationError(`${txn.txn_type} must have positive qty_base`);
  }
  if (outflowTypes.includes(txn.txn_type) && txn.qty_base > 0) {
    throw new ValidationError(`${txn.txn_type} must have negative qty_base`);
  }

  // All physical outflows must go through FIFO lot selection.
  const fifoOnlyTypes: TxnType[] = [
    'consume',
    'sell',
    'transfer_out',
    'waste',
  ];
  if (fifoOnlyTypes.includes(txn.txn_type)) {
    throw new ValidationError(
      `${txn.txn_type} must be posted through consumeFIFO to enforce FIFO lot selection`
    );
  }

  // M1: sanitize note for formula injection
  const sanitized: Omit<InventoryTransaction, 'txn_id' | 'timestamp'> = {
    ...txn,
    user_id: session.userId,
    note: sanitizeNote(txn.note),
  };

  return appendTransaction(sanitized);
}

// ─── getLots ──────────────────────────────────────────────────────────────────

/**
 * Returns active lots (remaining_qty > 0) for an item at a location, sorted
 * oldest-received first (FIFO order).
 */
export async function getLots(
  itemId: string,
  locationId: string,
  session: Session
): Promise<Lot[]> {
  requireLocationAccess(session, locationId);
  const allLots = await getAllLots();
  return allLots
    .filter(
      (l) =>
        l.item_id === itemId &&
        l.location_id === locationId &&
        l.remaining_qty > 0
    )
    .sort((a, b) => {
      if (a.received_date < b.received_date) return -1;
      if (a.received_date > b.received_date) return 1;
      return a.lot_id.localeCompare(b.lot_id);
    });
}

// ─── getMovementHistory ───────────────────────────────────────────────────────

/**
 * Returns all transactions for an item at a location.
 * Sorted newest-first (descending timestamp) for display / audit use.
 * locationId is required so access can be scoped and checked.
 */
export async function getMovementHistory(
  itemId: string,
  locationId: string,
  session: Session
): Promise<InventoryTransaction[]> {
  requireLocationAccess(session, locationId);
  const txns = await getAllTransactions();
  return txns
    .filter((t) => t.item_id === itemId && t.location_id === locationId)
    .sort((a, b) => {
      // ISO timestamps sort lexicographically in descending order.
      if (a.timestamp > b.timestamp) return -1;
      if (a.timestamp < b.timestamp) return 1;
      return 0;
    });
}

// ─── reconcileLotBalance ──────────────────────────────────────────────────────

/**
 * Derives the correct remaining_qty for a lot from the canonical transaction
 * ledger, validates it, then writes it back via setLotRemainingById.
 *
 * Invariants enforced:
 *  - At least one positive (creation) transaction must exist for the lot.
 *  - derived remaining must be ≥ 0.
 *  - derived remaining must be ≤ lot.original_qty.
 *
 * Returns the repaired logical lot with the correct remaining_qty.
 */
export async function reconcileLotBalance(lot: Lot): Promise<Lot> {
  const canonicalTxns = await getCanonicalTransactions();
  const lotTxns = canonicalTxns.filter((t) => t.lot_id === lot.lot_id);

  const hasPositiveCreation = lotTxns.some((t) => t.qty_base > 0);
  if (!hasPositiveCreation) {
    throw new IntegrityConflictError(
      `Lot ${lot.lot_id}: no positive creation transaction found in ledger`
    );
  }

  const derivedRemaining = lotTxns.reduce((sum, t) => sum + t.qty_base, 0);

  if (derivedRemaining < 0) {
    throw new IntegrityConflictError(
      `Lot ${lot.lot_id}: derived remaining_qty is negative (${derivedRemaining})`
    );
  }

  if (
    Number(normalizeLedgerNumber(derivedRemaining)) >
    Number(normalizeLedgerNumber(lot.original_qty))
  ) {
    throw new IntegrityConflictError(
      `Lot ${lot.lot_id}: derived remaining_qty (${derivedRemaining}) exceeds original_qty (${lot.original_qty})`
    );
  }

  await setLotRemainingById(lot.lot_id, derivedRemaining);
  return { ...lot, remaining_qty: derivedRemaining };
}

// ─── ensureInboundPortion ─────────────────────────────────────────────────────

export type LotInput = Lot;
export type TransactionInput = EnsureTransactionInput;

/**
 * The ONLY path through which receiving/transfer services may create inventory.
 *
 * Steps:
 *  1. ensureLot — idempotently creates or verifies the lot in the data layer.
 *  2. ensureTransaction — idempotently appends the creation transaction.
 *  3. reconcileLotBalance — derives remaining_qty from the ledger and writes
 *     it back, repairing any staleness from a prior interrupted run.
 *
 * Idempotent: calling twice with the same IDs converges to the same state.
 */
export async function ensureInboundPortion({
  lot,
  transaction,
  session,
}: {
  lot: LotInput;
  transaction: TransactionInput;
  session: Session;
}): Promise<{ lot: Lot; transaction: InventoryTransaction }> {
  requireLocationAccess(session, lot.location_id);

  const { value: canonicalLot } = await ensureLot(lot);
  const { value: canonicalTxn } = await ensureTransaction(
    transaction,
    session.userId
  );
  const repairedLot = await reconcileLotBalance(canonicalLot);

  return { lot: repairedLot, transaction: canonicalTxn };
}

// ─── reconcileFifoOutflow ─────────────────────────────────────────────────────

export interface ReconcileFifoOutflowParams {
  transferId: string;
  itemId: string;
  /** Requested quantity in base units (positive). */
  requestedQtyBase: number;
  /** Candidate lots in FIFO order (oldest first). Caller supplies them sorted. */
  sourceLots: Lot[];
  session: Session;
  /**
   * Returns the deterministic transaction ID for a given source lot ID.
   * Must return a non-blank string — blank is rejected as non-deterministic.
   */
  transactionIdForLot: (lotId: string) => string;
}

/**
 * Ledger-first FIFO reconciliation for transfer outflows.
 *
 * Algorithm:
 *  1. Read canonical outflow transactions for this transferId + itemId.
 *  2. Calculate already-shipped quantity from existing outflows.
 *  3. Reconcile each candidate lot balance from canonical transactions.
 *  4. Preflight: throw if requestedQty > (available after existing outflows).
 *  5. For each lot needed: append deterministic transaction BEFORE decrementing
 *     remaining_qty (via reconcileLotBalance), then advance to next lot.
 *
 * Idempotent: if some outflows already exist, only missing quantities are added.
 */
export async function reconcileFifoOutflow(
  params: ReconcileFifoOutflowParams
): Promise<void> {
  const { transferId, itemId, requestedQtyBase, sourceLots, session, transactionIdForLot } =
    params;

  // Validate the ID factory before any writes.
  for (const lot of sourceLots) {
    const candidateId = transactionIdForLot(lot.lot_id);
    if (!candidateId.trim()) {
      throw new ValidationError(
        `transactionIdForLot returned a blank ID for lot ${lot.lot_id} — IDs must be deterministic`
      );
    }
  }

  // 1. Read canonical transactions — both existing outflows and lot creation txns.
  const canonicalTxns = await getCanonicalTransactions();

  // 2. Sum already-shipped quantity for this transfer + item.
  const existingOutflows = canonicalTxns.filter(
    (t) =>
      t.txn_type === 'transfer_out' &&
      t.ref_type === 'transfer' &&
      t.ref_id === transferId &&
      t.item_id === itemId
  );
  const alreadyShipped = existingOutflows.reduce(
    (sum, t) => sum + Math.abs(t.qty_base),
    0
  );
  const stillNeeded = Number(normalizeLedgerNumber(requestedQtyBase - alreadyShipped));

  if (stillNeeded <= 0) {
    // All outflows already exist — nothing to do.
    return;
  }

  // 3. Reconcile each lot's available balance from the ledger.
  //    available = sum of canonical txns for that lot (includes prior outflows
  //    from this or other transfers — we must not double-draw).
  const lotAvailable = new Map<string, number>();
  for (const lot of sourceLots) {
    const lotTxns = canonicalTxns.filter((t) => t.lot_id === lot.lot_id);
    const derived = lotTxns.reduce((sum, t) => sum + t.qty_base, 0);
    lotAvailable.set(lot.lot_id, Math.max(0, derived));
  }

  // 4. Preflight: verify enough stock is available.
  const totalAvailable = sourceLots.reduce(
    (sum, lot) => sum + (lotAvailable.get(lot.lot_id) ?? 0),
    0
  );
  if (totalAvailable < stillNeeded) {
    throw new ValidationError(
      `Insufficient stock for item ${itemId} on transfer ${transferId}: ` +
        `still need ${stillNeeded}, available ${totalAvailable}`
    );
  }

  // 5. Walk lots oldest-first (caller must supply sorted), append transactions
  //    and repair lot balances.
  let remaining = stillNeeded;
  for (const lot of sourceLots) {
    if (remaining <= 0) break;

    const available = lotAvailable.get(lot.lot_id) ?? 0;
    if (available <= 0) continue;

    const take = Math.min(available, remaining);
    const txnId = transactionIdForLot(lot.lot_id);

    // Append the outflow transaction BEFORE updating remaining_qty.
    await ensureTransaction(
      {
        txn_id: txnId,
        item_id: itemId,
        location_id: lot.location_id,
        lot_id: lot.lot_id,
        qty_base: -take,
        txn_type: 'transfer_out',
        ref_type: 'transfer',
        ref_id: transferId,
        unit_cost: lot.unit_cost,
        user_id: session.userId,
      },
      session.userId
    );

    // Reconcile the lot balance from the now-updated ledger.
    await reconcileLotBalance(lot);

    remaining -= take;
  }
}
