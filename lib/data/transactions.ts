import 'server-only';

import { randomUUID } from 'node:crypto';
import { getRows, appendRow } from './sheets';
import { parseNum, parseEnum } from '../types';
import { normalizeLedgerNumber } from '../services/deterministicIds';
import {
  IntegrityConflictError,
  RetryableMutationError,
} from '../services/errors';
import type { InventoryTransaction, TxnType, RefType } from '../types';

// Tab column order (0-based):
// txn_id, timestamp, item_id, location_id, lot_id, qty_base,
// txn_type, ref_type, ref_id, unit_cost, user_id, note

const TAB = 'Transactions';

const TXN_TYPES: readonly TxnType[] = [
  'receive',
  'transfer_out',
  'transfer_in',
  'consume',
  'yield',
  'sell',
  'count_adjust',
  'waste',
];

const REF_TYPES: readonly RefType[] = ['receipt', 'transfer', 'order', 'manual'];

export interface EnsureResult<T> {
  value: T;
  outcome: 'created' | 'existing';
}

export type EnsureTransactionInput = Omit<
  InventoryTransaction,
  'timestamp' | 'user_id'
> & {
  user_id?: string;
};

function rowToTransaction(row: string[]): InventoryTransaction {
  // txn_type is load-bearing for the ledger — throw on invalid values.
  const txn_type = parseEnum(row[6], TXN_TYPES, 'txn_type');

  // ref_type is important but less catastrophic; warn and default to 'manual'.
  let ref_type: RefType;
  if (REF_TYPES.includes(row[7] as RefType)) {
    ref_type = row[7] as RefType;
  } else {
    console.warn(`Unknown ref_type "${row[7]}", defaulting to "manual"`);
    ref_type = 'manual';
  }

  return {
    txn_id: row[0] ?? '',
    timestamp: row[1] ?? '',
    item_id: row[2] ?? '',
    location_id: row[3] ?? '',
    lot_id: (row[4] ?? '') !== '' ? row[4] : undefined,
    qty_base: parseNum(row[5]),
    txn_type,
    ref_type,
    ref_id: row[8] ?? '',
    unit_cost: parseNum(row[9]),
    user_id: row[10] ?? '',
    note: (row[11] ?? '') !== '' ? row[11] : undefined,
  };
}

function transactionToRow(txn: InventoryTransaction): unknown[] {
  return [
    txn.txn_id,
    txn.timestamp,
    txn.item_id,
    txn.location_id,
    txn.lot_id ?? '',
    txn.qty_base,
    txn.txn_type,
    txn.ref_type,
    txn.ref_id,
    txn.unit_cost,
    txn.user_id,
    txn.note ?? '',
  ];
}

export { rowToTransaction, transactionToRow };

export async function getAllTransactions(): Promise<InventoryTransaction[]> {
  const rows = await getRows(TAB);
  return rows.filter((r) => r[0] !== '').map(rowToTransaction);
}

function hasSameEffect(
  left: Omit<InventoryTransaction, 'timestamp'>,
  right: Omit<InventoryTransaction, 'timestamp'>
): boolean {
  return (
    left.item_id === right.item_id &&
    left.location_id === right.location_id &&
    (left.lot_id ?? '') === (right.lot_id ?? '') &&
    normalizeLedgerNumber(left.qty_base) ===
      normalizeLedgerNumber(right.qty_base) &&
    left.txn_type === right.txn_type &&
    left.ref_type === right.ref_type &&
    left.ref_id === right.ref_id &&
    normalizeLedgerNumber(left.unit_cost) ===
      normalizeLedgerNumber(right.unit_cost) &&
    (left.note ?? '') === (right.note ?? '')
  );
}

export async function getCanonicalTransactions(): Promise<
  InventoryTransaction[]
> {
  const rows = await getRows(TAB);
  const groups = new Map<string, InventoryTransaction[]>();

  for (const row of rows) {
    if (!(row[0] ?? '').trim()) {
      throw new IntegrityConflictError(
        'Transaction row has a blank transaction ID'
      );
    }

    const transaction = rowToTransaction(row);
    const group = groups.get(transaction.txn_id);
    if (group) {
      group.push(transaction);
    } else {
      groups.set(transaction.txn_id, [transaction]);
    }
  }

  return Array.from(groups.entries()).map(([txnId, transactions]) => {
    const first = transactions[0];
    for (const transaction of transactions.slice(1)) {
      if (!hasSameEffect(first, transaction)) {
        throw new IntegrityConflictError(
          `Transaction ID ${txnId} has conflicting ledger effects`
        );
      }
    }

    return transactions.reduce((earliest, transaction) =>
      transaction.timestamp < earliest.timestamp ? transaction : earliest
    );
  });
}

export async function ensureTransaction(
  expected: EnsureTransactionInput,
  userId?: string
): Promise<EnsureResult<InventoryTransaction>> {
  if (!expected.txn_id.trim()) {
    throw new IntegrityConflictError('Transaction ID must be non-blank');
  }

  const existing = (await getCanonicalTransactions()).find(
    (transaction) => transaction.txn_id === expected.txn_id
  );
  if (existing) {
    if (
      !hasSameEffect(existing, {
        ...expected,
        user_id: expected.user_id ?? '',
      })
    ) {
      throw new IntegrityConflictError(
        `Transaction ID ${expected.txn_id} has a conflicting ledger effect`
      );
    }
    return { value: existing, outcome: 'existing' };
  }

  const transaction: InventoryTransaction = {
    ...expected,
    timestamp: new Date().toISOString(),
    user_id: expected.user_id ?? userId ?? '',
  };
  await appendRow(TAB, transactionToRow(transaction));

  const created = (await getCanonicalTransactions()).find(
    (candidate) => candidate.txn_id === expected.txn_id
  );
  if (!created) {
    throw new RetryableMutationError(
      `Transaction ${expected.txn_id} was not visible after append`
    );
  }
  if (!hasSameEffect(created, transaction)) {
    throw new IntegrityConflictError(
      `Transaction ID ${expected.txn_id} has a conflicting ledger effect`
    );
  }

  return { value: created, outcome: 'created' };
}

/**
 * Appends a new transaction to the ledger. This is the only write operation —
 * the Transactions tab is append-only. Never edit or delete rows here.
 */
export async function appendTransaction(
  data: Omit<InventoryTransaction, 'txn_id' | 'timestamp'>
): Promise<InventoryTransaction> {
  const txn: InventoryTransaction = {
    txn_id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...data,
  };
  await appendRow(TAB, transactionToRow(txn));
  return txn;
}
