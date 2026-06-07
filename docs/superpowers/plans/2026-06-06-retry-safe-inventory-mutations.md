# Retry-Safe Inventory Mutations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make receipts and transfers converge safely after partial Google Sheets writes by using deterministic artifact IDs, canonical reads, and ledger-derived lot reconciliation.

**Architecture:** The data layer gains storage-neutral `ensure` operations and canonical readers that collapse duplicate physical rows by deterministic ID. `lib/services/inventory.ts` becomes the only service that creates lots, appends inventory transactions, or repairs `remaining_qty`; receiving and transfer services build deterministic manifests and ask inventory to reconcile them. Status changes happen only after the persisted manifest is re-read and verified.

**Tech Stack:** TypeScript, Next.js App Router, Google Sheets API, Vitest, Playwright.

**Constraints:** Do not add or remove Sheet tabs or columns, install packages, touch credentials, delete files, or perform bulk data changes. The workspace root is not currently a Git repository, so commit steps are intentionally omitted.

---

## File Map

- Create `lib/services/deterministicIds.ts`: canonical decimal strings and deterministic SHA-256 IDs.
- Create `lib/services/authorization.ts`: session validation and operation-specific role/location policy.
- Create `lib/api/serviceResponse.ts`: shared route error-to-response mapping.
- Modify `lib/services/errors.ts`: add `401`, `409`, and `503` service errors.
- Modify `lib/data/transactions.ts`: caller-supplied deterministic transaction IDs, canonical duplicate handling, semantic conflict detection.
- Modify `lib/data/lots.ts`: caller-supplied deterministic lot IDs, duplicate-row reconciliation, updates to every physical row for a logical lot.
- Modify `lib/data/receipts.ts`: deterministic receipt and receipt-line ensure operations.
- Modify `lib/data/sheets.ts`: exact-ID row helpers needed by the entity data modules, without exposing Sheets outside `lib/data`.
- Modify `lib/services/inventory.ts`: inbound portion ensure, FIFO outflow reconciliation, canonical lot balance repair.
- Modify `lib/services/receiving.ts`: receipt manifest reconciliation with caller-retained `receiptId`.
- Modify `lib/services/transfers.ts`: retry-safe shipping, outbound manifest verification, and retry-safe receiving.
- Modify `lib/auth/stub.ts`: typed `401` failure outside development/test.
- Modify `app/api/receipts/route.ts` and `app/api/transfers/**/route.ts`: shared safe error mapping.
- Create/modify focused tests under `tests/unit/data`, `tests/unit/services`, `tests/unit/auth`, and `tests/unit/api`.
- Create `tests/e2e/retry-safe-inventory.spec.ts`: failure-injection smoke coverage using an in-memory/test data adapter or route-level test harness.

### Task 1: Deterministic IDs and Decimal Normalization

**Files:**
- Create: `lib/services/deterministicIds.ts`
- Create: `tests/unit/services/deterministicIds.test.ts`

- [ ] **Step 1: Write failing tests for stable numeric normalization**

```ts
describe('normalizeLedgerNumber', () => {
  it('normalizes equivalent values to the same six-decimal string', () => {
    expect(normalizeLedgerNumber(1.2)).toBe('1.200000');
    expect(normalizeLedgerNumber(1.2000001)).toBe('1.200000');
  });

  it('rejects non-finite and positive values that round to zero', () => {
    expect(() => normalizePositiveLedgerNumber(Number.NaN)).toThrow();
    expect(() => normalizePositiveLedgerNumber(0.0000001)).toThrow();
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run tests/unit/services/deterministicIds.test.ts
```

Expected: fail because `deterministicIds.ts` does not exist.

- [ ] **Step 3: Implement normalization**

Implement:

```ts
export const LEDGER_DECIMALS = 6;

export function normalizeLedgerNumber(value: number): string {
  if (!Number.isFinite(value)) throw new ValidationError('number must be finite');
  return value.toFixed(LEDGER_DECIMALS);
}

export function normalizePositiveLedgerNumber(value: number): string {
  const normalized = normalizeLedgerNumber(value);
  if (Number(normalized) <= 0) {
    throw new ValidationError('number must remain positive after normalization');
  }
  return normalized;
}
```

- [ ] **Step 4: Add failing tests for deterministic keys**

```ts
it('returns the same opaque ID for the same ordered components', () => {
  expect(deterministicId('txn:xout:v1', ['t1', 'i1', 'lot1']))
    .toBe(deterministicId('txn:xout:v1', ['t1', 'i1', 'lot1']));
});

it('changes when component order or content changes', () => {
  expect(deterministicId('txn:xout:v1', ['t1', 'i1', 'lot1']))
    .not.toBe(deterministicId('txn:xout:v1', ['t1', 'lot1', 'i1']));
});
```

- [ ] **Step 5: Implement `deterministicId` using `node:crypto`**

Use `createHash('sha256')`, hash `JSON.stringify(trimmedComponents)`, and return
`prefix + ':' + digest.slice(0, 32)`.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run tests/unit/services/deterministicIds.test.ts
```

Expected: all tests pass.

### Task 2: Typed Errors, Session Validation, and Route Mapping

**Files:**
- Modify: `lib/services/errors.ts`
- Create: `lib/services/authorization.ts`
- Create: `lib/api/serviceResponse.ts`
- Modify: `lib/auth/stub.ts`
- Modify: `app/api/receipts/route.ts`
- Modify: `app/api/transfers/route.ts`
- Modify: `app/api/transfers/[id]/approve/route.ts`
- Modify: `app/api/transfers/[id]/ship/route.ts`
- Modify: `app/api/transfers/[id]/receive/route.ts`
- Create: `tests/unit/services/authorization.test.ts`
- Create: `tests/unit/api/serviceResponse.test.ts`
- Modify: `tests/unit/auth/stub.test.ts`

- [ ] **Step 1: Write failing error/status tests**

Cover:

```ts
expect(new UnauthorizedError('missing session').status).toBe(401);
expect(new IdempotencyConflictError('changed payload').status).toBe(409);
expect(new IntegrityConflictError('bad ledger').status).toBe(409);
expect(new RetryableMutationError('retry').status).toBe(503);
```

- [ ] **Step 2: Implement the new typed errors**

Expand `ServiceError.status` to `401 | 400 | 403 | 404 | 409 | 503`.

- [ ] **Step 3: Write failing session tests**

Test:

```ts
expect(() => assertValidSession({
  userId: 'site-user',
  role: Role.kitchen_manager,
  assignedLocationIds: 'all',
})).toThrow(ForbiddenError);

expect(() => assertValidSession({
  userId: '',
  role: Role.kitchen_manager,
  assignedLocationIds: ['school-1'],
})).toThrow(UnauthorizedError);
```

- [ ] **Step 4: Implement `assertValidSession` and operation helpers**

Provide small helpers:

```ts
assertValidSession(session);
requireRole(session, allowedRoles);
requireAssignedLocation(session, locationId);
requireDirectorEndpointAccess(session, fromLocationId, toLocationId);
```

Only `director_admin` may use `'all'`.

- [ ] **Step 5: Write authorization matrix tests**

Cover:

- Kitchen manager assigned only to destination can request from a warehouse and receive there.
- Warehouse user assigned only to source can ship to an unassigned destination.
- Kitchen manager cannot ship.
- Warehouse user cannot receive at an unassigned destination.
- Director approval requires both endpoints unless assigned locations are `'all'`.

- [ ] **Step 6: Implement operation-specific authorization**

Do not use a generic both-endpoint check for request, ship, or receive. Use the matrix in `docs/design/retry-safe-inventory-mutations.md`.

- [ ] **Step 7: Write failing response mapper tests**

Verify `UnauthorizedError` maps to `401 {"error":"Unauthorized"}`, forbidden maps to `403`, validation/not-found/conflict retain safe messages, and plain `Error` maps to generic `500`.

- [ ] **Step 8: Implement and wire `serviceErrorResponse`**

All five routes should delegate catch blocks to one mapper.

- [ ] **Step 9: Make the production auth stub throw `UnauthorizedError`**

Update the auth test to expect a typed `401` error.

- [ ] **Step 10: Run focused tests**

```bash
npx vitest run tests/unit/auth/stub.test.ts tests/unit/services/authorization.test.ts tests/unit/api/serviceResponse.test.ts
```

Expected: pass.

### Task 3: Canonical Transaction Data Access

**Files:**
- Modify: `lib/data/transactions.ts`
- Create: `tests/unit/data/transactions.test.ts`

- [ ] **Step 1: Write failing tests for caller-supplied transaction IDs**

Test that `ensureTransaction(expected)` appends `expected.txn_id` when absent and returns the existing row without appending when present.

- [ ] **Step 2: Write failing semantic-conflict test**

Two rows with the same `txn_id` but different `qty_base`, item, location, lot, type, reference, cost, or note must throw `IntegrityConflictError`.

- [ ] **Step 3: Write failing canonical duplicate test**

Two physical rows with the same deterministic ID and same semantic effect must produce one logical transaction. The canonical timestamp is the earliest timestamp and on-hand counts it once.

- [ ] **Step 4: Implement transaction semantic equality**

Compare normalized quantity/cost strings plus:

```ts
item_id
location_id
lot_id ?? ''
txn_type
ref_type
ref_id
note ?? ''
```

Do not include `timestamp` or `user_id` in inventory-effect equality.

- [ ] **Step 5: Implement `getCanonicalTransactions`**

Group rows by `txn_id`, validate each group, choose the earliest timestamp, and preserve that row's audit metadata.

- [ ] **Step 6: Implement `ensureTransaction`**

Algorithm:

1. Read canonical transactions and match `txn_id`.
2. If present, validate semantics and return `existing`.
3. If absent, append with caller-supplied ID and server timestamp/user.
4. Re-read canonical transactions.
5. Return the matching row or throw `RetryableMutationError`.

- [ ] **Step 7: Run focused tests**

```bash
npx vitest run tests/unit/data/transactions.test.ts tests/unit/data/rowMappers.test.ts
```

Expected: pass.

### Task 4: Canonical Lot Data Access

**Files:**
- Modify: `lib/data/lots.ts`
- Modify: `lib/data/sheets.ts`
- Create: `tests/unit/data/lots.test.ts`

- [ ] **Step 1: Write failing deterministic lot tests**

Test absent, existing-identical, and same-ID/conflicting-immutable-fields cases for `ensureLot(expected)`.

- [ ] **Step 2: Write failing duplicate physical lot test**

Two rows with the same `lot_id` and identical immutable fields but different `remaining_qty` must be returned as one logical lot and be repairable by updating every matching physical row.

- [ ] **Step 3: Add a data-layer exact-row update helper**

Keep it inside `lib/data`. Add a helper that can update all data rows matching an ID in column A. Do not expose Google APIs to services.

- [ ] **Step 4: Implement canonical lot grouping**

Immutable equality includes item, location, received/expiration dates, original quantity, cost, and source reference. A mismatch throws `IntegrityConflictError`.

- [ ] **Step 5: Implement `ensureLot` and `setLotRemainingById`**

`ensureLot` follows read/append/re-read. `setLotRemainingById` overwrites every physical row sharing the logical `lot_id`.

- [ ] **Step 6: Run focused tests**

```bash
npx vitest run tests/unit/data/lots.test.ts tests/unit/data/rowMappers.test.ts
```

Expected: pass.

### Task 5: Deterministic Receipt Data Access

**Files:**
- Modify: `lib/data/receipts.ts`
- Create: `tests/unit/data/receipts.test.ts`

- [ ] **Step 1: Write failing receipt ensure tests**

Test:

- `ensureReceipt` preserves the first `receipt_date` and `received_by`.
- Reusing a receipt ID with changed source, order, or location throws `IdempotencyConflictError`.
- `ensureReceiptLine` distinguishes duplicate business lines by deterministic `line_id`.
- An existing line with changed quantity, unit, cost, item, or expiration throws `IdempotencyConflictError`.

- [ ] **Step 2: Implement caller-supplied receipt and line IDs**

Do not generate random IDs in `ensureReceipt` or `ensureReceiptLine`.

- [ ] **Step 3: Add receipt-line manifest queries**

Expose `getReceiptLines(receiptId)` for unexpected-extra-line validation.

- [ ] **Step 4: Run focused tests**

```bash
npx vitest run tests/unit/data/receipts.test.ts tests/unit/data/rowMappers.test.ts
```

Expected: pass.

### Task 6: Inventory Reconciliation Primitives

**Files:**
- Modify: `lib/services/inventory.ts`
- Modify: `tests/unit/services/inventory.test.ts`

- [ ] **Step 1: Write failing canonical on-hand/value tests**

`getOnHand` must use canonical transactions. `getInventoryValue` must use canonical lots so duplicate physical rows do not double-count value.

- [ ] **Step 2: Write failing `reconcileLotBalance` tests**

Given a lot with one positive creation transaction and FIFO outflows:

```ts
derivedRemaining = sum(canonical txns where lot_id === lotId)
```

Test valid repair, below-zero conflict, above-original conflict, and missing positive creation transaction.

- [ ] **Step 3: Implement `reconcileLotBalance`**

Validate the derived balance, call `setLotRemainingById`, and return the repaired logical lot.

- [ ] **Step 4: Write failing `ensureInboundPortion` tests**

Cover:

- Lot exists, transaction absent: append transaction and repair balance.
- Transaction exists, lot absent: create lot and repair balance.
- Both exist: no writes.
- Same deterministic ID with changed effect: `409`.
- Failure after append is resolved by re-read.

- [ ] **Step 5: Implement `ensureInboundPortion`**

This is the only service API used by receiving/transfer receive to create inventory:

```ts
ensureInboundPortion({
  lot,
  transaction,
  session,
});
```

It calls data-layer `ensureLot`, data-layer `ensureTransaction`, then reconciles the lot.

- [ ] **Step 6: Write failing `reconcileFifoOutflow` tests**

Cover partial existing outflows, multiple FIFO lots, transaction append before lot projection update, status-retry behavior, overdraw detection, and deterministic transaction ID validation.

- [ ] **Step 7: Implement ledger-first FIFO reconciliation**

For requested item quantity:

1. Validate existing operation outflows.
2. Calculate already-shipped quantity.
3. Reconcile candidate lot balances from canonical transactions.
4. Preflight remaining availability.
5. Append deterministic transaction before changing `remaining_qty`.
6. Reconcile the affected lot after each append.
7. Re-read and require exact requested quantity.

- [ ] **Step 8: Run focused tests**

```bash
npx vitest run tests/unit/services/inventory.test.ts
```

Expected: pass.

### Task 7: Receipt Manifest Reconciliation

**Files:**
- Modify: `lib/services/receiving.ts`
- Modify: `app/api/receipts/route.ts`
- Modify: `tests/unit/services/receiving.test.ts`

- [ ] **Step 1: Write failing input contract tests**

Require `receiptId` matching `^rcpt:v1:[0-9a-fA-F-]{36}$`. Reject missing/malformed IDs before writes.

- [ ] **Step 2: Write failing interrupted-receipt tests**

Cover retry after header, line, lot, and transaction phases. Assert one logical receipt, line, lot, and receive transaction after each retry.

- [ ] **Step 3: Write failing changed-payload tests**

Reordering, adding, removing, or changing lines under the same `receiptId` returns `IdempotencyConflictError` before additional inventory writes.

- [ ] **Step 4: Implement the expected receipt manifest**

For submitted index `i`:

```ts
lineId = deterministicId('rline:v1', [receiptId, String(i)]);
lotId = deterministicId('lot:recv:v1', [receiptId, lineId]);
txnId = deterministicId('txn:recv:v1', [receiptId, lineId]);
```

- [ ] **Step 5: Reconcile header and lines**

Ensure the receipt header, reject unexpected lines, then ensure each expected line.

- [ ] **Step 6: Delegate inventory creation exclusively to `ensureInboundPortion`**

Remove direct `createLot` imports from `receiving.ts`.

- [ ] **Step 7: Return created vs reconciled outcome**

The route returns `201` for a newly created receipt header and `200` for a retry/reconciliation.

- [ ] **Step 8: Run focused tests**

```bash
npx vitest run tests/unit/services/receiving.test.ts
```

Expected: pass.

### Task 8: Retry-Safe Transfer Shipping

**Files:**
- Modify: `lib/services/transfers.ts`
- Modify: `tests/unit/services/transfers.test.ts`

- [ ] **Step 1: Write failing source-only authorization tests**

Warehouse assigned only to source can ship to an unassigned destination. Kitchen/site roles cannot ship.

- [ ] **Step 2: Write failing partial-shipment retry tests**

Cover:

- One item complete, later item absent.
- One FIFO lot complete, later lot absent.
- All outflows complete but status still `approved`.
- Status already `in_transit`.

Assert only missing quantities are appended and source on-hand decreases once.

- [ ] **Step 3: Write failing existing-outbound integrity tests**

Reject positive quantities, wrong source, unexpected item, wrong cost, wrong lot, non-deterministic IDs, and shipped quantity greater than requested.

- [ ] **Step 4: Aggregate `TransferLines` by item**

Normalize base-unit quantities to six decimals. Repeated item lines form one requested quantity.

- [ ] **Step 5: Call `reconcileFifoOutflow` per item**

Use:

```ts
transactionIdForLot: (lotId) =>
  deterministicId('txn:xout:v1', [transferId, itemId, lotId])
```

- [ ] **Step 6: Verify exact outbound aggregate**

Before status update, re-read canonical outflows and require exact equality with the aggregated lines.

- [ ] **Step 7: Advance status last**

Accept `approved` and `in_transit`; derive `ship_date` from the earliest outbound timestamp. A retry must not append more inventory movement.

- [ ] **Step 8: Run focused tests**

```bash
npx vitest run tests/unit/services/transfers.test.ts
```

Expected: pass.

### Task 9: Outbound Manifest Verification and Retry-Safe Transfer Receive

**Files:**
- Modify: `lib/services/transfers.ts`
- Modify: `tests/unit/services/transfers.test.ts`

- [ ] **Step 1: Write failing outbound-balance tests**

Reject missing, short, excess, extra-item, wrong-source, positive, and conflicting outbound transactions before any destination write.

- [ ] **Step 2: Implement `verifyOutboundManifest`**

Return canonical outbound portions only after their per-item totals exactly match aggregated `TransferLines`.

- [ ] **Step 3: Write destination-only authorization tests**

Kitchen/site user assigned only to destination can receive. Warehouse user without destination assignment cannot receive there.

- [ ] **Step 4: Write interrupted inbound tests**

Cover destination lot without transaction, transaction without status update, status already `received`, and duplicate physical rows.

- [ ] **Step 5: Build deterministic inbound artifacts**

For each outbound transaction:

```ts
lotId = deterministicId('lot:xin:v1', [transferId, outbound.txn_id]);
txnId = deterministicId('txn:xin:v1', [transferId, outbound.txn_id]);
```

- [ ] **Step 6: Call `ensureInboundPortion`**

Remove direct lot creation from `transfers.ts`. Preserve item, quantity, and cost from the outbound transaction.

- [ ] **Step 7: Reject unexpected inbound artifacts**

Any transfer-in transaction or destination lot linked to the transfer that is not in the expected deterministic manifest is an `IntegrityConflictError`.

- [ ] **Step 8: Advance received status last**

Accept `in_transit` and `received`; preserve the first receive date and session-stamped receiver.

- [ ] **Step 9: Run focused tests**

```bash
npx vitest run tests/unit/services/transfers.test.ts
```

Expected: pass.

### Task 10: Unit Regression and Build Gate

**Files:**
- Modify only files implicated by failures.

- [ ] **Step 1: Run all unit tests**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 2: Run lint**

```bash
node node_modules/eslint/bin/eslint.js
```

Expected: exit code 0 with no warnings.

- [ ] **Step 3: Run TypeScript**

```bash
node node_modules/typescript/bin/tsc --noEmit
```

Expected: exit code 0.

- [ ] **Step 4: Run production build**

```bash
node node_modules/next/dist/bin/next build
```

Expected: build succeeds; the existing multiple-lockfile warning is acceptable.

### Task 11: Code Review and Security Gate

**Files:**
- Review all files changed in Tasks 1-10.

- [ ] **Step 1: Code reviewer checks invariants**

Require a `PASS` verdict for append-only ledger behavior, FIFO, transfer balance, inventory-service centralization, retry convergence, access policy, and tests.

- [ ] **Step 2: Address every blocking finding with TDD**

For each accepted issue, add a failing regression test, implement the smallest repair, and rerun Task 10.

- [ ] **Step 3: Security engineer checks authorization and integrity**

Require no Critical or High findings. Verify safe `401/403/409/503` behavior and no credential exposure.

- [ ] **Step 4: Address every blocking security finding with TDD**

Add regression coverage and rerun Task 10.

### Task 12: Playwright Smoke Test

**Files:**
- Create: `tests/e2e/retry-safe-inventory.spec.ts`
- Modify: `package.json` only to add scripts using already-installed Playwright.
- Modify: `playwright.config.ts` only if needed for the existing local server.

- [ ] **Step 1: Add scripts without changing dependencies**

Add:

```json
"test": "vitest run",
"test:e2e": "playwright test"
```

- [ ] **Step 2: Implement a failure-injection test harness**

Use test-only data adapters or route dependency injection. Do not call real Google Sheets and do not expose failure injection in production routes.

- [ ] **Step 3: Test receipt retry**

Submit one fixed `receiptId`, inject failure between deterministic lot and transaction, retry, and assert one logical lot/transaction plus correct on-hand/value.

- [ ] **Step 4: Test transfer ship retry**

Receive two costed source lots, ship across both, inject failure after first outbound append, retry, and assert FIFO, exact source decrement, and `in_transit`.

- [ ] **Step 5: Test transfer receive retry**

Inject failure between destination lot and transfer-in transaction, retry, and assert exact destination increment, preserved costs, and `received`.

- [ ] **Step 6: Test authorization and auth failure**

Exercise source-only warehouse shipping, destination-only kitchen receiving, forbidden cross-role actions, and production auth returning `401`.

- [ ] **Step 7: Run Playwright**

```bash
npx playwright test
```

Expected: all smoke tests pass.

### Task 13: Final Verification

- [ ] **Step 1: Run the complete gate**

```bash
node node_modules/eslint/bin/eslint.js
npx vitest run
node node_modules/typescript/bin/tsc --noEmit
node node_modules/next/dist/bin/next build
npx playwright test
```

Expected: every command exits 0.

- [ ] **Step 2: Confirm project constraints**

Verify:

- No Sheet tab or column changed.
- No package installed or upgraded.
- No credential or `.env.local` file touched.
- No transaction row edit/delete path added.
- Receiving and transfer services no longer create or mutate lots directly.
- The root still lacks Git metadata; report that the definition-of-done commit cannot be completed until the repository is initialized or restored.
