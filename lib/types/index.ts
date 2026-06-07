// ─── Enumerations ────────────────────────────────────────────────────────────

export enum ClientType {
  Warehouse = 'Warehouse',
  School = 'School',
  Vending = 'Vending',
  Private = 'Private',
}

export enum Role {
  director_admin = 'director_admin',
  warehouse = 'warehouse',
  kitchen_manager = 'kitchen_manager',
  vending_route = 'vending_route',
  private_site = 'private_site',
}

export type TxnType =
  | 'receive'
  | 'transfer_out'
  | 'transfer_in'
  | 'consume'
  | 'yield'
  | 'sell'
  | 'count_adjust'
  | 'waste';

export type TransferStatus =
  | 'requested'
  | 'approved'
  | 'in_transit'
  | 'received'
  | 'cancelled';

export type OrderStatus =
  | 'draft'
  | 'placed'
  | 'partially_received'
  | 'received'
  | 'closed';

export type VendorType = 'broadline' | 'produce' | 'other';

export type ItemType = 'purchased' | 'produced' | 'retail';

export type RefType = 'receipt' | 'transfer' | 'order' | 'manual';

// ─── Core Entities ────────────────────────────────────────────────────────────

export interface Item {
  item_id: string;
  name: string;
  category: string;
  item_type: ItemType;
  base_unit: string;
  barcode_sku?: string;
  default_unit_cost: number;
  usda_commodity: boolean;
  allergens?: string;
  nutrition_ref?: string;
  default_vendor_id?: string;
  active: boolean;
}

export interface UnitConversion {
  conversion_id: string;
  item_id: string;
  from_unit: string;
  base_qty_per_unit: number;
  label: string;
}

export interface Recipe {
  recipe_id: string;
  produced_item_id: string;
  yield_qty: number;
  yield_unit: string;
  serving_size: number;
}

export interface RecipeComponent {
  component_id: string;
  recipe_id: string;
  component_item_id: string;
  qty: number;
  unit: string;
}

export interface Vendor {
  vendor_id: string;
  name: string;
  type: VendorType;
  contact: string;
  active: boolean;
}

export interface Order {
  order_id: string;
  vendor_id: string;
  destination_location_id: string;
  order_date: string;
  expected_date?: string;
  status: OrderStatus;
}

export interface OrderLine {
  line_id: string;
  order_id: string;
  item_id: string;
  qty: number;
  unit: string;
  unit_cost: number;
}

export interface Location {
  location_id: string;
  name: string;
  client_type: ClientType;
  address: string;
  active: boolean;
}

export interface Lot {
  lot_id: string;
  item_id: string;
  location_id: string;
  received_date: string;
  expiration_date?: string;
  original_qty: number;
  remaining_qty: number;
  unit_cost: number;
  source_ref: string;
}

export interface InventoryTransaction {
  txn_id: string;
  timestamp: string;
  item_id: string;
  location_id: string;
  lot_id?: string;
  qty_base: number;
  txn_type: TxnType;
  ref_type: RefType;
  ref_id: string;
  unit_cost: number;
  user_id: string;
  note?: string;
}

export interface Transfer {
  transfer_id: string;
  from_location_id: string;
  to_location_id: string;
  status: TransferStatus;
  requested_by: string;
  approved_by?: string;
  received_by?: string;
  request_date: string;
  ship_date?: string;
  receive_date?: string;
}

export interface TransferLine {
  line_id: string;
  transfer_id: string;
  item_id: string;
  qty: number;
  unit: string;
}

export interface Receipt {
  receipt_id: string;
  order_id?: string;
  source: string;
  location_id: string;
  receipt_date: string;
  received_by: string;
}

export interface ReceiptLine {
  line_id: string;
  receipt_id: string;
  item_id: string;
  qty_received: number;
  unit: string;
  unit_cost: number;
  expiration_date?: string;
}

export interface LaborHours {
  labor_id: string;
  location_id: string;
  date: string;
  hours: number;
  entered_by: string;
}

export interface User {
  user_id: string;
  name: string;
  email: string;
  role: Role;
  assigned_location_ids: string[];
}

// ─── Session ──────────────────────────────────────────────────────────────────

export interface Session {
  userId: string;
  role: Role;
  // 'all' means the user has access to every location (e.g. director_admin stub).
  // A string array means access is scoped to exactly those location IDs.
  assignedLocationIds: string[] | 'all';
}

// ─── Row-mapper helpers (pure, no I/O) ───────────────────────────────────────

/**
 * Parse a boolean stored as 'true'/'false'/'1'/'0' in Sheets, case-insensitive.
 * Any value that is not explicitly truthy maps to false (no "anything-not-false" ambiguity).
 */
export const parseBoolean = (v: string | undefined): boolean => {
  const lower = (v ?? '').toLowerCase();
  return lower === 'true' || lower === '1';
};

/**
 * Parse a numeric cell. Returns `fallback` (default 0) when the cell is blank
 * or not a finite number, preventing NaN from entering the ledger.
 */
export const parseNum = (v: string | undefined, fallback = 0): number => {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Parse a load-bearing enum field. Throws on unrecognised values so corrupt
 * Sheets data surfaces immediately rather than being silently masked.
 */
export function parseEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  field: string
): T {
  if (allowed.includes(value as T)) return value as T;
  throw new Error(`Invalid ${field}: "${value}"`);
}
