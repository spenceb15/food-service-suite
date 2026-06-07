# Graph Report - .  (2026-06-06)

## Corpus Check
- 104 files · ~50,818 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 557 nodes · 1359 edges · 48 communities (24 shown, 24 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 74 edges (avg confidence: 0.9)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Data Access Layer|Data Access Layer]]
- [[_COMMUNITY_Inventory Ledger & FIFO|Inventory Ledger & FIFO]]
- [[_COMMUNITY_API Layer & Auth|API Layer & Auth]]
- [[_COMMUNITY_API Route Handlers|API Route Handlers]]
- [[_COMMUNITY_Retry-Safe Mutations Plan|Retry-Safe Mutations Plan]]
- [[_COMMUNITY_Project Dependencies|Project Dependencies]]
- [[_COMMUNITY_Idempotent Transactions|Idempotent Transactions]]
- [[_COMMUNITY_Scaffold Dependencies|Scaffold Dependencies]]
- [[_COMMUNITY_Dev Agents & Workflow|Dev Agents & Workflow]]
- [[_COMMUNITY_Scaffold TypeScript Config|Scaffold TypeScript Config]]
- [[_COMMUNITY_TypeScript Configuration|TypeScript Configuration]]
- [[_COMMUNITY_Labor Hours Tracking|Labor Hours Tracking]]
- [[_COMMUNITY_Graphify Knowledge Graph|Graphify Knowledge Graph]]
- [[_COMMUNITY_Claude Code Settings|Claude Code Settings]]
- [[_COMMUNITY_Scaffold App Layout|Scaffold App Layout]]
- [[_COMMUNITY_Root App Layout|Root App Layout]]
- [[_COMMUNITY_Local Claude Permissions|Local Claude Permissions]]
- [[_COMMUNITY_Scaffold Root Files|Scaffold Root Files]]
- [[_COMMUNITY_Test & Build Config|Test & Build Config]]
- [[_COMMUNITY_Lint Configuration|Lint Configuration]]
- [[_COMMUNITY_Next.js Configuration|Next.js Configuration]]
- [[_COMMUNITY_Conflict Error Types|Conflict Error Types]]
- [[_COMMUNITY_CSS Configuration|CSS Configuration]]
- [[_COMMUNITY_Scaffold Lint Config|Scaffold Lint Config]]
- [[_COMMUNITY_Scaffold Next.js Config|Scaffold Next.js Config]]
- [[_COMMUNITY_Scaffold CSS Config|Scaffold CSS Config]]
- [[_COMMUNITY_Root Layout Component|Root Layout Component]]
- [[_COMMUNITY_Home Page Component|Home Page Component]]
- [[_COMMUNITY_Retryable Error Type|Retryable Error Type]]
- [[_COMMUNITY_File SVG Icon|File SVG Icon]]
- [[_COMMUNITY_Globe SVG Icon|Globe SVG Icon]]
- [[_COMMUNITY_Next.js Logo|Next.js Logo]]
- [[_COMMUNITY_Vercel Logo|Vercel Logo]]
- [[_COMMUNITY_Window SVG Icon|Window SVG Icon]]
- [[_COMMUNITY_Order Entity|Order Entity]]
- [[_COMMUNITY_Order Line Entity|Order Line Entity]]
- [[_COMMUNITY_Receipt Line Entity|Receipt Line Entity]]
- [[_COMMUNITY_Transfer Line Entity|Transfer Line Entity]]
- [[_COMMUNITY_Unit Conversion Entity|Unit Conversion Entity]]
- [[_COMMUNITY_Scaffold Agents Config|Scaffold Agents Config]]
- [[_COMMUNITY_Scaffold README|Scaffold README]]

## God Nodes (most connected - your core abstractions)
1. `getSession()` - 45 edges
2. `serviceErrorResponse()` - 44 edges
3. `getRows()` - 38 edges
4. `appendRow()` - 35 edges
5. `ValidationError` - 28 edges
6. `Role` - 23 edges
7. `parseNum()` - 22 edges
8. `requireRole()` - 20 edges
9. `ForbiddenError` - 18 edges
10. `postTransaction()` - 18 edges

## Surprising Connections (you probably didn't know these)
- `GET()` --calls--> `getAllItems()`  [EXTRACTED]
  app/api/items/route.ts → lib/data/items.ts
- `POST()` --calls--> `createItem()`  [EXTRACTED]
  app/api/items/route.ts → lib/data/items.ts
- `POST()` --calls--> `createOrder()`  [EXTRACTED]
  app/api/orders/route.ts → lib/data/orders.ts
- `GET()` --calls--> `getAllReceipts()`  [EXTRACTED]
  app/api/receipts/route.ts → lib/data/receipts.ts
- `POST()` --calls--> `receiveDelivery()`  [EXTRACTED]
  app/api/receipts/route.ts → lib/services/receiving.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Transfer Lifecycle API Endpoints (request→approve→ship→receive)** — api_transfers_post, approve_route_patch, ship_route_patch, receive_route_patch [EXTRACTED 0.95]
- **Shared API Handler Pattern (getSession + requireRole + serviceErrorResponse)** — auth_stub_getsession, api_serviceresponse_serviceerrorresponse, api_items_get, api_locations_get, api_orders_get, api_receipts_get, api_transfers_get, api_users_get, api_vendors_get [INFERRED 0.95]
- **Data Layer Modules (Google Sheets via getRows/appendRow pattern)** — data_items_getallitems, data_items_createitem, data_locations_getalllocations, data_locations_createlocation, data_lots_getalllots, data_lots_createlot, data_lots_updatelot, data_orders_getallorders, data_orders_createorder, data_laborhours_getalllaborhours, data_laborhours_createlaborhours [INFERRED 0.95]
- **FIFO Inventory Write Path: consumeFIFO + appendTransaction + updateLot** — services_inventory_consumefifo, data_transactions_appendtransaction, concept_fifo_ledger [INFERRED 0.95]
- **Transfer Balance Invariant: shipTransfer (transfer_out) + receiveTransfer (transfer_in) + lot recreation** — services_transfers_shiptransfer, services_transfers_receivetransfer, concept_transfer_state_machine [INFERRED 0.95]
- **Receiving Pipeline: receiveDelivery creates Receipt + ReceiptLine + Lot + postTransaction** — services_receiving_receivedelivery, data_receipts_createreceipt, services_inventory_posttransaction [EXTRACTED 1.00]
- **Core Ledger Invariants Tested Across Service Layer** — append_only_ledger_principle, fifo_invariant, transfer_balance_invariant, services_inventory_test, services_transfers_test, data_transactions_test [INFERRED 0.85]
- **Access Control Gates Tested Across All Services** — services_authorization_test, services_inventory_test, services_receiving_test, services_transfers_test, services_laborhours_test, services_recipes_test [INFERRED 0.85]
- **Row Mapper Round-Trip Test Pattern (Sheets ↔ Entity)** — data_rowmappers_test, data_transactions_test, services_receiving_test [INFERRED 0.75]
- **Specialist Agent Team Workflow** — agents_brainstormer_agent, agents_backend_developer_agent, agents_code_reviewer_agent, agents_frontend_developer_agent, agents_security_engineer_agent, agents_e2e_smoke_tester_agent [EXTRACTED 1.00]
- **Retry-Safe Inventory Mutation Operations** — retry_safe_receipt_reconciliation, retry_safe_ship_transfer, retry_safe_receive_transfer [EXTRACTED 1.00]
- **Idempotency Mechanism (Deterministic IDs + Ensure Pattern + Canonical Reads)** — retry_safe_deterministic_ids, retry_safe_ensure_pattern, retry_safe_canonical_transactions [EXTRACTED 1.00]
- **FIFO Lot-Based Ledger Consumption** — shared_core_spec_fifo_consumption, shared_core_spec_lot_entity, shared_core_spec_inventory_transaction_entity [EXTRACTED 0.95]
- **Retry-Safe Mutation: Deterministic IDs + Ensure Ops + Canonical Readers** — plans_retry_safe_deterministic_ids, plans_retry_safe_ensure_operations, plans_retry_safe_canonical_readers [EXTRACTED 0.95]
- **Receipt Manifest creates Lot and Transaction via ensureInboundPortion** — plans_retry_safe_receipt_manifest, plans_retry_safe_ensure_inbound_portion, plans_retry_safe_reconcile_lot_balance [EXTRACTED 0.95]

## Communities (48 total, 24 thin omitted)

### Community 0 - "Data Access Layer"
Cohesion: 0.05
Nodes (81): Google Sheets Data Access Layer, Google Sheets Non-Transactional Race Condition Risk, createItem(), ITEM_TYPES, itemToRow(), rowToItem(), rowToLaborHours(), createLot() (+73 more)

### Community 1 - "Inventory Ledger & FIFO"
Cohesion: 0.07
Nodes (57): server-only Mock (Vitest), Append-Only Ledger Principle, FIFO Append-Only Ledger Invariant, In-Process Async Mutex for Concurrent Inventory Mutation, Transfer State Machine (requested→approved→in_transit→received), getAllLots(), appendTransaction(), getAllTransactions() (+49 more)

### Community 2 - "API Layer & Auth"
Cohesion: 0.09
Nodes (39): getAllItems(), getAllRecipeComponents(), getAllRecipes(), Fail-Closed in Production Principle, Formula-Injection Prevention (note sanitization), ITEM_TYPES, VALID_ROLES, ALL_ROLES (+31 more)

### Community 3 - "API Route Handlers"
Cohesion: 0.07
Nodes (47): GET /api/items, POST /api/items, GET /api/locations, POST /api/locations, GET /api/orders, POST /api/orders, validSession, GET /api/receipts (+39 more)

### Community 4 - "Retry-Safe Mutations Plan"
Cohesion: 0.07
Nodes (47): Authorization Matrix (Role/Location Policy), lib/services/authorization.ts, Canonical Readers (Duplicate Row Collapse), Deterministic Artifact IDs, lib/services/deterministicIds.ts, tests/e2e/retry-safe-inventory.spec.ts, ensureInboundPortion Service API, Storage-Neutral Ensure Operations (+39 more)

### Community 5 - "Project Dependencies"
Cohesion: 0.07
Nodes (26): dependencies, googleapis, next, react, react-dom, server-only, devDependencies, eslint (+18 more)

### Community 6 - "Idempotent Transactions"
Cohesion: 0.15
Nodes (18): EnsureResult, ensureTransaction(), EnsureTransactionInput, getCanonicalTransactions, getCanonicalTransactions(), hasSameEffect(), REF_TYPES, rowToTransaction() (+10 more)

### Community 7 - "Scaffold Dependencies"
Cohesion: 0.09
Nodes (21): dependencies, next, react, react-dom, devDependencies, eslint, eslint-config-next, tailwindcss (+13 more)

### Community 8 - "Dev Agents & Workflow"
Cohesion: 0.18
Nodes (21): Backend Developer Agent, Brainstormer Agent, Code Reviewer Agent, Core Invariants (Ledger, FIFO, Transfers, Base Units, Access), E2E Smoke Tester Agent, Frontend Developer Agent, AGENTS.md Project Constitution, Security Engineer Agent (+13 more)

### Community 9 - "Scaffold TypeScript Config"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+11 more)

### Community 10 - "TypeScript Configuration"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+11 more)

### Community 11 - "Labor Hours Tracking"
Cohesion: 0.22
Nodes (13): createLaborHours(), getAllLaborHours(), laborHoursToRow(), enterLaborHours(), EnterLaborHoursInput, getLaborHours(), getMPLH(), adminSession (+5 more)

### Community 12 - "Graphify Knowledge Graph"
Cohesion: 0.22
Nodes (9): Graphify Skill, Graphify Add and Watch Reference, Graphify Exports Reference, Graphify Extraction Spec, Graphify GitHub and Merge Reference, Graphify Hooks Reference, Graphify Query Reference, Graphify Transcribe Reference (+1 more)

### Community 13 - "Claude Code Settings"
Cohesion: 0.33
Nodes (5): hooks, PreToolUse, permissions, allow, deny

### Community 14 - "Scaffold App Layout"
Cohesion: 0.40
Nodes (3): geistMono, geistSans, metadata

### Community 17 - "Scaffold Root Files"
Cohesion: 0.67
Nodes (3): tmp-scaffold RootLayout, tmp-scaffold package.json, tmp-scaffold Home Page

### Community 18 - "Test & Build Config"
Cohesion: 0.67
Nodes (3): TypeScript Compiler Config, server-only Mock Alias, Vitest Test Configuration

## Knowledge Gaps
- **179 isolated node(s):** `allow`, `deny`, `PreToolUse`, `allow`, `ITEM_TYPES` (+174 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **24 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `getRows()` connect `Data Access Layer` to `Inventory Ledger & FIFO`, `API Layer & Auth`, `API Route Handlers`, `Idempotent Transactions`, `Labor Hours Tracking`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **Why does `getSession()` connect `API Route Handlers` to `Data Access Layer`, `Inventory Ledger & FIFO`, `API Layer & Auth`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **Why does `serviceErrorResponse()` connect `API Route Handlers` to `Data Access Layer`, `Inventory Ledger & FIFO`, `API Layer & Auth`?**
  _High betweenness centrality (0.020) - this node is a cross-community bridge._
- **What connects `allow`, `deny`, `PreToolUse` to the rest of the system?**
  _185 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Data Access Layer` be split into smaller, more focused modules?**
  _Cohesion score 0.05393939393939394 - nodes in this community are weakly interconnected._
- **Should `Inventory Ledger & FIFO` be split into smaller, more focused modules?**
  _Cohesion score 0.06997929606625258 - nodes in this community are weakly interconnected._
- **Should `API Layer & Auth` be split into smaller, more focused modules?**
  _Cohesion score 0.08672659968270756 - nodes in this community are weakly interconnected._