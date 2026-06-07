# Food Service Suite — Shared Core Design Spec (v0.1)

This is the foundation every client-line module (Schools/NSLP, Vending, Private) builds on. It defines the data model, the core mechanics, the role-scoped screens, and the Google Sheets v0 datastore with a migration path.

---

## 1. Design principles

1. **Inventory is a ledger, not a number.** On-hand is never stored as an editable value. Every event writes one signed transaction; on-hand is the running sum. This gives a perpetual, real-time inventory, a free audit trail, and reversible corrections.
2. **FIFO is one mechanism doing two jobs.** Stock is tracked in dated lots. Consuming oldest-first is simultaneously the food-safety rotation rule and the cost-flow method, so inventory value falls out of the same operation.
3. **Modules are views, not new machinery.** Schools, Vending, and Private all read and write the same ledger; they only differ in screens and rules. A location's `client_type` tag is the switch.
4. **Simplicity per role.** Each user sees only their locations and a handful of tasks. Fast input (scan, defaults, natural units) over comprehensive forms.
5. **One data access layer.** The app talks to storage through a single module. v0 storage is Google Sheets; swapping to Postgres/Supabase later is a contained change, not a rewrite.

---

## 2. Architecture

```
            ┌─────────────────────────────────────────┐
            │            Role-scoped UI                 │
            │  Warehouse · Kitchen Mgr · Director · …    │
            └───────────────────┬───────────────────────┘
                                │
            ┌───────────────────▼───────────────────────┐
            │      Core services (the only path in)      │
            │  inventory ledger · FIFO/costing · transfers│
            │  receiving · recipes · reports              │
            └───────────────────┬───────────────────────┘
                                │  (data access layer)
            ┌───────────────────▼───────────────────────┐
            │  v0: Google Sheets   →   later: Postgres    │
            └─────────────────────────────────────────────┘

   Client-line modules (Schools / Vending / Private) sit beside the
   core UI and call the same core services — they add screens + rules,
   never their own inventory logic.
```

---

## 3. Data model

Bold entities/fields are the ones the latest requirements (FIFO, costing, recipe cost, MPLH, vendors, direct delivery) introduced.

### Item
| field | notes |
|---|---|
| item_id (PK) | |
| name | |
| category | e.g. produce, dairy, dry goods, retail |
| item_type | purchased / produced / retail |
| base_unit | the unit everything normalizes to (e.g. each, lb, oz) |
| barcode_sku | for scan input |
| **default_unit_cost** | latest known cost, for planning/recipe estimates |
| usda_commodity | bool (Schools/USDA Foods) |
| allergens, nutrition_ref | optional, used by Schools module |
| default_vendor_id | optional |
| active | |

### UnitConversion
item_id · from_unit · base_qty_per_unit (e.g. case → 24) · label. Lets staff count in natural units while the ledger stays in base units.

### Recipe (BOM) + RecipeComponent
**Recipe:** recipe_id · produced_item_id · yield_qty · yield_unit · serving_size.
**RecipeComponent:** recipe_id · component_item_id · qty · unit. Producing the recipe consumes its components and yields the produced item.

### Vendor
vendor_id · name · type (broadline / produce / other) · contact · active.
Seed data: Nicholas and Company (broadline), Sysco (broadline), A-to-Z Produce (produce).

### Order (PO) + OrderLine
**Order:** order_id · vendor_id · destination_location_id (warehouse **or** a building for direct delivery) · order_date · expected_date · status (draft / placed / partially_received / received / closed).
**OrderLine:** order_id · item_id · qty · unit · unit_cost.

### Location
location_id · name · **client_type (Warehouse / School / Vending / Private)** · address · active. Optional sub-locations (zone/aisle/bin) attach later for warehouse mapping.

### Lot  *(the FIFO + costing layer)*
lot_id · item_id · location_id · received_date · expiration_date (optional) · original_qty (base) · **remaining_qty (base)** · **unit_cost (base)** · source_ref (receipt_id or transfer_id). Inventory value at a location = Σ(remaining_qty × unit_cost) over its lots.

### InventoryTransaction  *(the ledger)*
txn_id · timestamp · item_id · location_id · lot_id (nullable) · qty_base (signed) · txn_type (receive / transfer_out / transfer_in / consume / yield / sell / count_adjust / waste) · ref_type · ref_id · unit_cost · user_id · note. **Append-only.**

### Transfer + TransferLine
**Transfer:** transfer_id · from_location_id · to_location_id · status (requested / approved / in_transit / received / cancelled) · requested_by · approved_by · received_by · request_date · ship_date · receive_date.
**TransferLine:** transfer_id · item_id · qty · unit.

### Receipt + ReceiptLine
**Receipt:** receipt_id · order_id (nullable = blind receive) · source (vendor_id or transfer_id) · location_id (where received) · receipt_date · received_by.
**ReceiptLine:** receipt_id · item_id · qty_received · unit · unit_cost · expiration_date. Each line creates a Lot and posts a `receive` transaction.

### LaborHours  *(for MPLH)*
labor_id · location_id · date · hours · entered_by.

### User + Role
user_id · name · email (Google Workspace) · role (director_admin / warehouse / kitchen_manager / vending_route / private_site) · assigned_location_ids[]. Access is scoped to assigned locations.

---

## 4. Core mechanics

**On-hand(item, location)** = Σ qty_base of its transactions. Always derived, never stored.

**FIFO consumption.** To remove quantity Q of an item at a location: walk that location's lots by oldest `received_date`, decrement `remaining_qty`, and post a `consume`/`transfer_out`/`sell` transaction per lot at that lot's `unit_cost` until Q is satisfied. This enforces rotation and produces the cost of goods used in one pass.

**Inventory value** = Σ(remaining_qty × unit_cost) across lots — no separate valuation routine.

**Recipe cost.** Roll up RecipeComponents: Σ(component qty in base × component unit cost) ÷ servings = cost per serving. Two flavors, both supported:
- *Planning cost* — uses `Item.default_unit_cost` (fast estimate for menu planning).
- *Actual cost* — uses the real lot costs consumed during a production run (true cost of what was made).

**Production run** (core provides the transactions; the Schools module adds compliance fields): FIFO-consume each component, then `yield` the produced item as a new lot whose `unit_cost` = total consumed cost ÷ yield. Produced inventory is now costed and ready to consume or sell downstream.

**Meals per labor hour (MPLH)** = meal_equivalents(location, date) ÷ labor_hours(location, date). Labor hours come from the LaborHours entity; meal equivalents are derived from production/sales using configurable conversion factors (set when the Schools module is built).

**Receiving — three inbound paths, all posting to the correct location:**
- Vendor → warehouse: received at warehouse, creates costed lots there.
- Vendor → building (direct delivery): received at the building (Order.destination = that building), creates lots there.
- Warehouse → building: handled by Transfer (below).

**Transfers / fulfillment — both ends update:** request → approve → **ship** (FIFO `transfer_out` at source, status = in_transit) → **receive** (`transfer_in` at destination, lots recreated carrying the source cost). In-transit is the visible gap between ship and receive, so stock is never double-counted or lost mid-move.

---

## 5. Roles & screens

**Warehouse worker**
- Receive delivery — scan item, enter qty/unit/cost/expiration → creates lots.
- Fulfill transfer requests — pick list, mark shipped.
- Count / adjust warehouse stock.
- Low-stock & expiring-lot lists.

**Kitchen manager (core slice; production added by Schools module)**
- My inventory — on-hand for their kitchen.
- Request a transfer from the warehouse.
- Receive a transfer or a direct vendor delivery.
- Count / adjust.
- Enter labor hours.

**Director / Admin**
- Manage items, recipes, vendors, locations, users.
- Place orders; approve transfers.
- Dashboards: on-hand and inventory value by location, recipe cost, MPLH, movement history.

Every screen is filtered to the user's `assigned_location_ids` and role.

---

## 6. Reports (built on the ledger)

Inventory value by location (FIFO) · Recipe cost & cost per serving · MPLH by building/day · Item movement history (audit) · Low-stock / reorder · Expiring lots (food safety).

---

## 7. Google Sheets v0 layout

One Workspace spreadsheet, one tab per entity, columns matching the fields above:

`Items` · `UnitConversions` · `Recipes` · `RecipeComponents` · `Vendors` · `Orders` · `OrderLines` · `Locations` · `Lots` · `Transactions` (append-only) · `Transfers` · `TransferLines` · `Receipts` · `ReceiptLines` · `LaborHours` · `Users`.

Google Drive holds attachments (e.g. delivery photos). All reads/writes go through the data access layer so storage is swappable.

**Known limits to plan around (none block starting):**
- Sheets isn't transactional — simultaneous writes from multiple kitchens can race. Funnel writes through the core service and keep the Transactions tab append-only.
- ~10M-cell ceiling — the transaction log grows forever, so plan an archive/migration before it's large.
- FIFO cost layering and MPLH rollups get slow in a spreadsheet — fine for v0 volumes, a trigger to migrate later.

**Migration path:** when volume or concurrency strains Sheets, repoint the data access layer at Postgres/Supabase. Entity and field names carry over unchanged.

---

## 8. Build order (shared core)

1. Sheets + data access layer; seed Items, UnitConversions, Locations, Vendors, Users.
2. Receiving → Lots with cost (creates the first real inventory).
3. On-hand + inventory value (FIFO) + movement history.
4. Transfers (ship/receive, in-transit) + direct-delivery receiving.
5. Recipes/BOM + recipe cost (planning and actual).
6. Labor hours + MPLH report.
7. Dashboards & low-stock/expiring reports.

Client-line modules (Schools/NSLP, Vending, Private) layer on after the core is solid.

---

## 9. Assumptions & open items

**Assumed (change if wrong):** vendors are Nicholas and Company, Sysco, A-to-Z Produce · FIFO costing basis · one central warehouse · in-transit shown as a distinct state · Google Sheets as v0 datastore.

**Deferred to module work (non-blocking):** meal-equivalent conversion factors for MPLH · whether recipe screens default to planning vs. actual cost · warehouse sub-location/bin mapping detail · barcode source for items without existing SKUs.
