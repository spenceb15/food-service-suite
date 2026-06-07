# AGENTS.md — Project Constitution

This file is read automatically by every Codex agent in this project. It is the source of standing rules. The full design is in `docs/shared-core-spec.md` — read it before building.

---

## Mission

Build a modular food-service management suite for a company that serves three distinct client lines from one central warehouse:

- **Schools** — charter schools under the National School Lunch Program (NSLP); federally regulated, needs production records and meal-pattern compliance.
- **Vending** — vending machines and micromarkets; restock-to-par logic, inventory pool kept separate from schools.
- **Private** — clients not tied to schools; flexible, lightweight rules.

Modularity is the whole point: one shared core, three client-line modules that switch on per location. **We are currently building the shared core only.** Client-line modules come later.

---

## Tech stack

- Language: **TypeScript**
- Framework: **Next.js (App Router)** — React UI + server-side API routes
- Styling: **Tailwind CSS**
- Datastore (v0): **Google Sheets** via the Google Sheets API, behind a single data access layer
- Tests: **Vitest** (unit) + **Playwright** (end-to-end)
- Auth: Google Workspace accounts

The Google service-account credentials MUST stay server-side (API routes only) and MUST never reach the browser or the repo. This is the main reason the app has a server side at all.

---

## Architecture rules

1. **One data access layer.** All reads/writes go through `lib/data/` (the data layer). No component, page, or service calls the Google Sheets API directly. This is what makes the later swap to Postgres/Supabase a contained change.
2. **One inventory service.** All inventory changes go through `lib/services/inventory.ts`. The UI never writes transactions or edits lots directly.
3. **Modules are views.** Schools/Vending/Private add screens and rules only; they call core services and never invent their own inventory logic.

---

## Core invariants (do not violate)

These are the rules a reviewer must enforce on every change. Most bugs in systems like this come from breaking one of these.

1. **Inventory is a ledger.** On-hand is always derived as the running sum of `InventoryTransaction` rows. Never store an editable on-hand number. The `Transactions` store is **append-only** — corrections are new offsetting transactions, never edits or deletes.
2. **FIFO, always.** Consumption, transfers out, and sales draw from the oldest lot first (by `received_date`). Each outflow transaction records the consumed lot's `unit_cost`. Inventory value = Σ(lot.remaining_qty × lot.unit_cost).
3. **Transfers balance.** Shipping posts `transfer_out` at the source (FIFO) and sets status `in_transit`. Receiving posts `transfer_in` at the destination, recreating lots that carry the source cost. Stock in transit is shown as its own state and is never counted at either location until received.
4. **Everything in base units.** All quantities are stored in the item's `base_unit`. Convert at the edge (input/display) using `UnitConversion`, never mid-ledger.
5. **Access is scoped.** Users only see and act on their `assigned_location_ids` and what their role allows.

---

## Conventions

- Folder layout: `app/` (routes + UI), `lib/data/` (data layer), `lib/services/` (core services), `lib/types/` (shared types), `tests/`, `docs/`.
- Every business rule (FIFO consumption, transfer balancing, recipe cost, MPLH) ships with unit tests.
- Secrets live only in `.env.local`, which is git-ignored. Never commit credentials or the service-account key.
- Keep each screen small and role-scoped: large touch targets, minimal typing, scan-first input where possible (warehouse and kitchen staff use tablets).

---

## Team workflow contract

The main session is the **manager**. It does not write production code; it decomposes work from the spec and delegates:

- design / data modeling / options → `brainstormer`
- server, services, data layer, API → `backend-developer`
- React screens and UI wiring → `frontend-developer`
- security & access-control review → `security-engineer`
- end-to-end smoke tests → `e2e-smoke-tester`
- review of every code change → `code-reviewer`

Flow for each feature: design → backend → **code-reviewer (must PASS)** → frontend → **code-reviewer (must PASS)** → security-engineer → e2e-smoke-tester (**must be green**) → commit → checkpoint. Nothing is "done" until the reviewer passes and smoke tests are green.

---

## Definition of done

A feature is done when: it follows the core invariants, has unit tests for its business rules, passes code review, passes a security pass, has a green Playwright smoke test for its critical path, and is committed to git.

---

## Hard stops — pause and ask the human for approval before:

- Installing or upgrading any package (`npm install`, etc.)
- Changing the Google Sheets structure (adding/removing tabs or columns) or any bulk/destructive data operation
- Deleting files or directories
- Pushing to a remote or deploying
- Touching `.env.local`, the service-account key, or anything credential-related
- Any action not clearly covered by the current task

These approvals can be granted from the Codex mobile app. When in doubt, propose the action and stop.
