# Retry-Safe Google Sheets Inventory Mutations

## Status and scope

This design repairs retry behavior for vendor/direct receipts, transfer shipping,
and transfer receiving while preserving the existing Google Sheets tabs and
columns.

Constraints:

- No Sheet tab, column, or schema changes.
- `Transactions` remains append-only.
- On-hand remains derived from the ledger.
- FIFO allocation and costing remain mandatory.
- Quantities are stored in item base units.
- Transfers remain balanced through `in_transit`.
- Access remains role- and location-scoped.
- Google Sheets cannot provide a true cross-process transaction. This design
  detects and repairs interrupted retries, but does not claim serializable
  concurrency between separate server processes.

Out of scope:

- A general workflow engine or new operation-log tab.
- Deleting duplicate Sheet rows.
- Automatic repair of conflicting business operations that concurrently
  overdraw the same lot.
- Application UI changes beyond retaining and resending a receipt operation ID.

## Approaches considered

### 1. Deterministic artifacts plus operation reconciliation

Give every lot and transaction created by an operation a deterministic ID.
Before and after writes, load the operation's existing artifacts, validate their
semantic content, create only missing artifacts, and repair mutable
`Lot.remaining_qty` from the canonical ledger.

Advantages:

- Handles an ambiguous API timeout because a retry can identify exactly what
  already committed.
- Repairs partial transfer shipping, lot/transaction pairs, and status-update
  failures.
- Uses existing IDs and reference fields.
- Maps naturally to unique keys and transactions after migration to Postgres.

Tradeoffs:

- Requires all ledger readers to collapse semantically identical duplicate
  `txn_id` rows. Sheets cannot enforce uniqueness during a cross-process append
  race.
- Reconciliation is more read-heavy than the current sequential writes.
- Different operations can still race for the same stock across processes.

### 2. Reconcile by business-field matching only

Keep random IDs and infer completed work from `ref_id`, item, quantity, cost,
location, and notes.

Advantages:

- Smaller data-layer API change.
- No client-provided receipt operation ID.

Tradeoffs:

- Ambiguous when a receipt has duplicate item lines or two portions have equal
  item, quantity, and cost.
- Cannot reliably pair an orphan lot with its intended transaction.
- Matching becomes order-dependent and brittle as fields evolve.

### 3. Encode an operation journal in existing rows

Write synthetic marker records into existing entities or transaction notes to
represent operation phases.

Advantages:

- Makes phases explicit without adding a tab.

Tradeoffs:

- Pollutes business entities or the inventory ledger with non-inventory state.
- A marker append is itself non-transactional and needs reconciliation.
- Zero-quantity marker transactions violate current ledger validation.
- Makes later migration harder than deterministic entity keys.

## Recommendation

Use approach 1. It is the simplest option that can unambiguously repair all
reviewed failure cases without changing Sheets. The operation's persisted
business records are the manifest; deterministic IDs identify each expected
artifact; reconciliation converges Sheets toward that manifest.

## Canonical values and deterministic IDs

### Canonical encoding

All deterministic IDs use:

```text
key(prefix, components) =
  prefix + ":" + first32hex(sha256(JSON.stringify(components)))
```

`components` is an ordered JSON array of already-trimmed strings. Numbers are
not used as ID components. This avoids delimiter ambiguity and produces a
128-bit hash suffix. Prefixes are lowercase ASCII.

IDs are opaque. Code must not recover business data by parsing a hash suffix.

### Quantity and cost normalization

This repair keeps the current service contract: callers supply quantities and
costs already expressed in the item's base unit. Unit conversion remains a
separate build-order item.

At the API edge:

- Round base quantity to six decimal places using one shared decimal helper.
- Round unit cost per base unit to six decimal places.
- Reject a positive input that rounds to zero.
- Store and compare the normalized numbers, not raw input numbers.
- Require the persisted line unit to be the item's base unit once item lookup
  is available at this boundary. Until then, retain the current explicit
  base-unit input contract.

Reconciliation compares normalized decimal strings, not binary floating-point
values with an arbitrary epsilon. For example, `1.2` and `1.200000` normalize to
the same stored value.

This fixed precision is a v0 policy because there is no per-item precision
column. It must be applied consistently in request validation, ID payload
validation, aggregation, and tests.

### Receipt operation key

`POST /api/receipts` requires:

```ts
interface ReceiveDeliveryInput {
  receiptId: string;
  orderId?: string;
  source: string;
  locationId: string;
  lines: ReceiveDeliveryLine[];
}
```

The caller creates `receiptId` once, before the first submission, in this
format:

```text
rcpt:v1:<uuid>
```

The same value must be retained for timeout/network retries. A genuinely new,
even identical, physical delivery gets a new `receiptId`. This uses the existing
`Receipts.receipt_id` field and avoids content-hash collisions between
legitimate identical deliveries.

Receipt artifacts:

| Artifact | Deterministic ID | Existing linkage |
|---|---|---|
| Receipt | caller's `receiptId` | `receipt_id` |
| Receipt line at zero-based submitted index `i` | `rline:v1:<hash([receiptId, String(i)])>` | `line_id`, `receipt_id` |
| Receipt lot | `lot:recv:v1:<hash([receiptId, lineId])>` | `lot_id`, `source_ref=receiptId` |
| Receive transaction | `txn:recv:v1:<hash([receiptId, lineId])>` | `txn_id`, `ref_type=receipt`, `ref_id=receiptId`, `lot_id` |

The submitted line order is part of the idempotency contract. Reusing a
`receiptId` with reordered, added, removed, or changed lines is a `409
Conflict`, not a new receipt.

System-generated receive transaction note:

```text
op:v1;receipt_line=<line_id>
```

### Transfer shipping keys

Transfer lines are aggregated by `item_id` after base-unit normalization.
Repeated item lines therefore produce one requested quantity per item.

For each source lot touched by FIFO:

```text
txn:xout:v1:<hash([transferId, itemId, sourceLotId])>
```

There is at most one logical `transfer_out` transaction for a
transfer/item/source-lot tuple. Its existing fields are:

- `lot_id=sourceLotId`
- `location_id=transfer.from_location_id`
- `txn_type=transfer_out`
- `ref_type=transfer`
- `ref_id=transferId`
- `qty_base` negative
- `unit_cost` copied from the source lot
- `note=op:v1;source_lot=<sourceLotId>`

### Transfer receiving keys

Each canonical `transfer_out` transaction is one inbound cost portion:

| Artifact | Deterministic ID | Existing linkage |
|---|---|---|
| Destination lot | `lot:xin:v1:<hash([transferId, outboundTxnId])>` | `source_ref=transferId` |
| Transfer-in transaction | `txn:xin:v1:<hash([transferId, outboundTxnId])>` | `ref_type=transfer`, `ref_id=transferId`, destination `lot_id` |

System-generated transfer-in note:

```text
op:v1;out_txn=<outbound_txn_id>;source_lot=<source_lot_id>
```

The destination lot copies item, quantity, and base-unit cost from the outbound
transaction. Its `original_qty` and initial `remaining_qty` equal
`abs(outbound.qty_base)`.

## Data-layer boundaries

The Sheets implementation stays behind `lib/data/`. Services do not call the
Google API directly.

Required storage-neutral interfaces:

```ts
interface EnsureResult<T> {
  value: T;
  outcome: 'created' | 'existing';
}

ensureReceipt(expected: Receipt): Promise<EnsureResult<Receipt>>;
ensureReceiptLine(expected: ReceiptLine): Promise<EnsureResult<ReceiptLine>>;
ensureLot(expected: Lot): Promise<EnsureResult<Lot>>;
ensureTransaction(
  expected: Omit<InventoryTransaction, 'timestamp'>
): Promise<EnsureResult<InventoryTransaction>>;

getCanonicalTransactions(filter?: TransactionFilter):
  Promise<InventoryTransaction[]>;
getLotsByIds(ids: string[]): Promise<Lot[]>;
setLotRemainingById(lotId: string, remainingQty: number): Promise<void>;
```

Rules for every `ensure`:

1. Read by deterministic ID.
2. If absent, append the caller-supplied ID and then re-read.
3. If present, compare immutable semantic fields.
4. Return existing when semantic fields match.
5. Throw `IntegrityConflictError` when the same ID has a different business
   effect.

For transactions, semantic equality includes item, location, lot, quantity,
type, reference, cost, and note. The first committed `timestamp` and `user_id`
remain the audit metadata. A later retry by another authorized user does not
replace them.

### Duplicate physical rows

Two server processes can both observe an absent ID and append it. Therefore:

- All ledger calculations use `getCanonicalTransactions`, grouped by `txn_id`.
- Rows with the same `txn_id` and the same semantic effect count once.
- Metadata differences such as append timestamp do not make the inventory
  effect different; the earliest timestamp is canonical and duplicates are
  logged.
- Rows with the same `txn_id` but different semantic effects cause an integrity
  conflict and block the mutation.
- No transaction row is deleted or edited.

Lots are grouped by `lot_id`. Duplicate lot rows are repairable only when their
immutable fields match. `remaining_qty` may differ because of an interrupted
update; reconciliation writes the same derived value to every physical row
with that lot ID. Conflicting immutable lot fields block the operation.

After migration to Postgres, these IDs become primary/unique keys and the
logical deduplication becomes database-enforced uniqueness.

## Inventory reconciliation boundary

`lib/services/inventory.ts` remains the only service allowed to change inventory
state. Higher-level receipt and transfer services ask it to ensure inflows,
reconcile FIFO outflows, and repair affected lots.

Proposed service interface:

```ts
ensureInboundPortion(input: {
  lot: Lot;
  transaction: Omit<InventoryTransaction, 'timestamp' | 'user_id'>;
  session: Session;
}): Promise<{ lot: Lot; transaction: InventoryTransaction }>;

reconcileFifoOutflow(input: {
  operationId: string;
  itemId: string;
  locationId: string;
  requestedQtyBase: number;
  txnType: 'transfer_out';
  refType: 'transfer';
  transactionIdForLot(sourceLotId: string): string;
  noteForLot(sourceLotId: string): string;
  session: Session;
}): Promise<InventoryTransaction[]>;

reconcileLotBalances(lotIds: string[]): Promise<void>;
```

### Canonical lot balance

For a lot created under this design:

```text
derived remaining =
  sum(canonical transaction.qty_base where transaction.lot_id = lot.lot_id)
```

The positive lot-creation transaction must equal `lot.original_qty`. All
lot-specific outflows reduce that sum. A derived balance below zero or above
`original_qty` is an integrity conflict.

Before allocating FIFO, and after every ambiguous write failure, reconcile the
affected lot rows to this ledger-derived value. The ledger is authoritative;
`remaining_qty` is the FIFO projection and may be repaired.

Legacy lots must first pass the same invariant. A lot with no matching positive
creation transaction or an unexplained ledger/lot mismatch is not guessed at
during a shipment. It raises an integrity conflict for explicit repair.

## Receipt reconciliation

`receiveDelivery` is serialized in-process by `receiptId`.

Algorithm:

1. Authenticate and authorize before reading receipt or inventory data.
2. Validate and normalize the complete request before writes.
3. Build the expected receipt header and indexed line manifest.
4. `ensureReceipt` using the caller's `receiptId`.
   - If new, set `receipt_date=today` and `received_by=session.userId`.
   - If existing, preserve its date and user and require order, source, and
     location to match.
5. Load all existing lines for the receipt.
   - Reject unexpected extra lines.
   - Reject any deterministic line ID whose normalized fields conflict.
6. For each submitted line in order:
   - `ensureReceiptLine`.
   - Build its deterministic lot and receive transaction.
   - `ensureLot`.
   - `ensureTransaction`.
   - Reconcile that lot's `remaining_qty` from canonical transactions.
7. Re-read and verify that every expected line, lot, and transaction exists
   exactly once logically and has the expected semantic effect.
8. Return the original receipt. Return `201` only when this call created the
   receipt header; return `200` when the header already existed and the call
   reconciled or verified it. The response body remains the Receipt object.

Failure behavior:

- Lot appended, transaction failed: retry finds the lot and appends only the
  missing transaction.
- Transaction append succeeded but the response failed: retry recognizes the
  transaction ID and does not double-count it.
- Cross-process duplicate lot or transaction append: canonical reads count one
  semantic artifact; lot rows are synchronized.
- Same `receiptId` with changed payload: `409 Conflict`; no new inventory write.

## Retry-safe transfer shipping

`shipTransfer` is serialized in-process by `transferId`, and each item/location
allocation also uses the inventory service's item/location mutex.

The operation accepts transfer status `approved` or `in_transit`:

- `approved` means reconcile and complete shipping.
- `in_transit` means verify/repair an already completed shipment and return
  idempotently.
- `received` is read-only: verify the outbound manifest is complete and return
  the transfer; never append more outbound rows.
- Other statuses fail validation.

Algorithm:

1. Authenticate and enforce the ship authorization policy.
2. Load transfer and lines; normalize and aggregate requested quantity by item.
3. Load canonical `transfer_out` transactions with
   `ref_type=transfer`, `ref_id=transferId`.
4. Validate every existing outbound row:
   - source location matches the transfer;
   - item exists in the requested aggregate;
   - quantity is negative and normalized;
   - source lot exists at the source and has the same item and cost;
   - transaction ID equals the deterministic ID for its tuple;
   - no tuple has two different semantic effects.
5. For each item, sum already shipped quantity.
   - More than requested is an integrity conflict.
   - Equal means no additional FIFO allocation.
   - Less means allocate only the remaining quantity.
6. Before allocation, reconcile candidate source lots from the canonical
   ledger, sort by `received_date`, then `lot_id`, and preflight total effective
   availability for every item.
7. Walk FIFO lots for the remaining quantity:
   - Calculate the take from ledger-derived remaining quantity.
   - `ensureTransaction` with the deterministic transfer-out ID.
   - Re-read canonical transactions for the affected lot.
   - Set every physical copy of that lot to its derived remaining balance.
8. Re-read all outbound rows and require exact aggregate equality with
   `TransferLines` for every item.
9. Set status to `in_transit` last. Derive `ship_date` from the earliest
   canonical outbound transaction timestamp, so a status-update retry on a
   later date does not change the actual ship date.
10. Re-read the transfer and outbound manifest before returning.

This repairs:

- Failure after only some transfer lines or FIFO lots were written.
- Failure after transaction append but before lot update.
- Failure after all transfer-out rows but before status update.
- Lost response after status update.

The implementation must append the ledger row before updating
`Lot.remaining_qty`. If the second write fails, the next reconciliation can
derive and restore the projection from the append-only ledger. It must not
decrement a lot first and then create a random transaction.

## Transfer receive precondition and reconciliation

`receiveTransfer` is serialized in-process by `transferId`.

It accepts `in_transit` or `received`:

- `in_transit` reconciles inbound artifacts and sets status last.
- `received` verifies/repairs deterministic inbound artifacts and returns
  idempotently.

Before any destination write, verify the outbound manifest:

1. Aggregate normalized `TransferLines` by item.
2. Load canonical transfer-out transactions for this transfer.
3. Apply all shipping integrity checks from the previous section.
4. Aggregate `abs(qty_base)` by item.
5. Require the exact same item keys and exact normalized quantities as
   `TransferLines`.
6. Reject zero, missing, extra, positive, wrong-location, wrong-reference, or
   conflicting outbound rows with `409 Integrity Conflict`.

Only a balanced outbound manifest is receivable.

Inbound algorithm:

1. Authenticate and enforce destination receive authorization.
2. Verify the outbound manifest above.
3. Choose the receive operation date:
   - If any deterministic destination lot already exists, require all existing
     inbound lots to use one date and reuse it.
   - Otherwise use today's date.
4. For each canonical outbound transaction, sorted by `txn_id`:
   - Build the deterministic destination lot and transfer-in transaction.
   - Validate any existing lot or transaction against the outbound item,
     absolute quantity, source cost, destination, and linkage.
   - `ensureLot`.
   - `ensureTransaction`.
   - Reconcile destination lot remaining from canonical transactions.
5. Reject any extra transfer-in transaction or destination lot linked to this
   transfer that is not in the deterministic outbound-derived manifest.
6. Re-read and require one logical inbound lot and transaction for every
   outbound portion, with total inbound quantity and cost layers matching
   outbound exactly.
7. Set transfer status to `received` last, with
   `received_by=session.userId` and `receive_date=receiveOperationDate`.
8. Re-read and return.

This avoids permanent orphan or duplicate inbound lots: an interrupted pair is
completed by ID, and duplicate physical appends have one logical effect.

## Authorization

### Session rules

Session construction and validation are centralized:

```ts
type Session = {
  userId: string;
  role: Role;
  assignedLocationIds: string[] | 'all';
};
```

- Only `director_admin` may have `assignedLocationIds='all'`.
- Any other role with `'all'` is an invalid/forbidden session and receives
  `403`.
- Empty or unknown user, expired Google session, missing Workspace identity,
  or production use of the development stub receives `401`.
- A valid identity lacking role or location permission receives `403`.
- Authorization runs before operation data is exposed or mutated.

### Operation allowlists and location checks

| Operation | Allowed roles | Required location access |
|---|---|---|
| Receive vendor/direct delivery | `director_admin`, `warehouse`, `kitchen_manager`, `vending_route`, `private_site` | destination only |
| Request transfer | `director_admin`, `warehouse`, `kitchen_manager`, `vending_route`, `private_site` | `warehouse`: source; site roles: destination; `director_admin`: both unless `'all'` |
| Approve transfer | `director_admin` | both endpoints unless `'all'` |
| Ship transfer | `director_admin`, `warehouse` | source only |
| Receive transfer | `director_admin`, `warehouse`, `kitchen_manager`, `vending_route`, `private_site` | destination only |

For a site-role request (`kitchen_manager`, `vending_route`, or
`private_site`), the source must be an active `Warehouse` location and the
destination must be one of the user's assigned active locations. This permits
the normal kitchen workflow: a kitchen manager assigned only to the kitchen can
request from the central warehouse and receive at the kitchen without being
granted warehouse access.

For a warehouse request, the source must be an assigned active warehouse.
Warehouse staff may ship to an unassigned destination because shipping reveals
and mutates source inventory only. Destination staff may receive without source
assignment because receiving reveals and mutates destination inventory only.

No operation should call a generic "require access to both transfer endpoints"
helper unless the matrix explicitly requires both.

## Error handling and API behavior

Service errors:

| Error | HTTP | Meaning |
|---|---:|---|
| `UnauthorizedError` | 401 | No valid production session |
| `ValidationError` | 400 | Invalid input or invalid state transition |
| `ForbiddenError` | 403 | Valid session lacks role/location permission |
| `NotFoundError` | 404 | Referenced entity does not exist |
| `IdempotencyConflictError` | 409 | Operation key reused with changed payload |
| `IntegrityConflictError` | 409 | Existing rows cannot be reconciled safely |
| `RetryableMutationError` | 503 | Sheets result remains ambiguous/incomplete after re-read |

All API routes use one error mapper. In particular, production `getSession()`
failure must become:

```json
{ "error": "Unauthorized" }
```

with status `401`, never a generic `500`.

After a Sheets timeout or transient error:

1. Re-read the deterministic artifact.
2. If it exists with the expected semantic effect, continue.
3. If absent, allow the outer reconciliation loop to retry the same ensure once.
4. If still ambiguous, return `503` with a safe instruction to retry the same
   operation key.
5. Never substitute a newly generated ID.

Internal Sheet names, row numbers, credentials, stack traces, and conflicting
row contents are logged server-side but not returned to the client.

## Concurrency limits and risks

### Same operation, concurrent retries

In-process operation mutexes reduce duplicate work. Cross-process retries may
append the same deterministic ID twice, but canonical ledger reads count the
same semantic ID once. Conflicting rows block the operation.

### Different operations against the same stock

Two server processes can independently read the same available lot and append
different valid transaction IDs that together overdraw it. Deterministic IDs do
not prevent this because Sheets has no compare-and-swap or transaction.

Mitigations:

- Keep item/location in-process mutexes.
- Re-read canonical lot balances immediately before and after each append.
- Detect a negative derived lot balance and stop with an integrity conflict.
- Do not silently delete or rewrite transactions.
- Repair requires an explicit append-only offsetting correction and review of
  the affected transfer before it can be received.
- Treat any observed cross-process overdraw as a migration trigger for a
  datastore with row locking and unique constraints.

This limitation is explicit and accepted for v0.

### Partial transfers

This design repairs a partially written shipment of the full requested
transfer. It does not introduce business-level partial fulfillment. A transfer
cannot become `in_transit` or receivable until outbound aggregates exactly
match all `TransferLines`.

### FIFO across multiple lots

Existing deterministic transfer-out rows are fixed consumed portions. A retry
does not re-plan them. It allocates only the remaining requested quantity from
the current ledger-derived FIFO balances. Before status advancement, all
portions are validated and their aggregate must equal the transfer request.

### Unit-conversion rounding

Conversion and six-decimal rounding happen once before persistence. A retry
normalizes with the same helper and compares normalized values. The service
never repeatedly converts already normalized Sheet values, avoiding drift.

## Acceptance criteria

### Unit tests

1. Receipt retry after header, line, and lot writes but before transaction
   creates only the missing transaction and repairs lot remaining.
2. Receipt retry after transaction append response loss produces one logical
   receive transaction and one logical lot.
3. Duplicate receipt lines for the same item/cost remain distinct by line ID.
4. Reusing a receipt ID with reordered or changed lines returns `409` and writes
   no additional inventory.
5. Transfer shipping interrupted after one of several item lines resumes only
   the missing item quantities.
6. Transfer shipping interrupted halfway through FIFO lots preserves existing
   portions and consumes the remaining quantity oldest-first.
7. Transfer-out append succeeds and lot update fails; retry derives and repairs
   the lot balance without another logical outflow.
8. All transfer-out rows succeed and status update fails; retry sets
   `in_transit` without additional inventory movement.
9. Duplicate physical rows with one deterministic transaction ID and the same
   semantic effect count once in on-hand and reconciliation.
10. Same deterministic transaction ID with a different quantity, item, lot, or
    cost returns an integrity conflict.
11. Receive is rejected when outbound item totals are less than, greater than,
    or contain different items from `TransferLines`.
12. Transfer receive interrupted after destination lot creation completes only
    the missing transfer-in transaction.
13. Transfer receive interrupted after transfer-in append but before status
    update does not duplicate lot or ledger effect.
14. Transfer receive preserves each source cost layer across multiple FIFO
    lots.
15. Repeated receive on status `received` returns idempotently after full
    reconciliation.
16. A kitchen manager assigned only to the destination can request from an
    active warehouse and receive the transfer, but cannot ship it.
17. A warehouse user assigned only to the source can ship to an unassigned
    kitchen, but cannot receive at that kitchen.
18. Approval remains restricted to `director_admin`.
19. Any non-director session with `assignedLocationIds='all'` receives `403`.
20. Missing/invalid production authentication maps to `401`; authenticated but
    unauthorized access maps to `403`.
21. Base-unit quantities normalize once to six decimals; retries produce
    identical aggregates and IDs.
22. Concurrent different-operation overdraw is detected as an integrity
    conflict and is not hidden by a lot-row overwrite.

### API and smoke tests

1. Submit a receipt with a fixed `receiptId`, inject a failure between lot and
   transaction, retry the same request, and verify:
   - one logical lot per line;
   - one logical receive transaction per line;
   - on-hand equals the receipt total;
   - inventory value equals the costed lot total.
2. Ship a transfer that spans at least two FIFO lots, inject a failure after the
   first transfer-out append, retry, and verify:
   - exact TransferLine aggregate shipped;
   - oldest lots consumed first;
   - source on-hand reduced once;
   - status `in_transit`;
   - no destination on-hand yet.
3. Inject a ship status-update failure after all outbound rows, retry, and
   verify no additional source reduction.
4. Attempt to receive a transfer whose outbound totals were tampered to differ
   from TransferLines; verify `409` and no destination writes.
5. Receive a valid transfer, inject a failure between destination lot and
   transfer-in transaction, retry, and verify:
   - every outbound cost portion has one logical destination lot and inbound
     transaction;
   - destination on-hand increases once;
   - source cost layers are preserved;
   - status becomes `received`.
6. Exercise the warehouse-to-kitchen workflow with separate source-only and
   destination-only users and verify the operation matrix.
7. Run an API route with production auth unavailable and verify status `401`
   with no internal error details.

## Implementation order

1. Add canonical decimal and deterministic ID helpers.
2. Add caller-supplied-ID `ensure` methods and canonical transaction reads to
   the data layer.
3. Centralize session validation, operation authorization, and route error
   mapping.
4. Add inventory inbound/FIFO/lot reconciliation primitives.
5. Convert receipt creation to manifest reconciliation.
6. Convert transfer shipping to aggregate reconciliation and status-last
   advancement.
7. Add outbound-manifest verification and deterministic transfer receive.
8. Add failure-injection unit and Playwright smoke tests.

No Sheet setup change or bulk data migration is required for the new keys.
Completed legacy operations remain readable. The deterministic retry guarantee
applies to operations created under this design; an already-partial legacy
receipt or shipment containing random artifact IDs must stop with an integrity
conflict for explicit audit rather than being guessed into the new manifest.
Legacy source lots may be used only after their lot/ledger invariant validates.
