/**
 * Unit tests for lib/data row-mapper functions.
 *
 * All mapper functions are pure (no I/O). We import the exported helpers
 * directly and test them in isolation — no Google Sheets API calls are made.
 *
 * Vitest globals are enabled in vitest.config.ts (no need to import describe/it/expect).
 */

import { describe, it, expect } from 'vitest';

// ─── Import mapper helpers ─────────────────────────────────────────────────────
// Each data module exports its row↔entity mappers for testability.

import { rowToItem, itemToRow } from '../../../lib/data/items';
import { rowToVendor, vendorToRow } from '../../../lib/data/vendors';
import { rowToLot, lotToRow } from '../../../lib/data/lots';
import { rowToTransaction, transactionToRow } from '../../../lib/data/transactions';
import { rowToTransfer } from '../../../lib/data/transfers';
import { rowToUnitConversion, unitConversionToRow } from '../../../lib/data/unitConversions';
import { rowToRecipe, recipeToRow } from '../../../lib/data/recipes';
import { rowToRecipeComponent, recipeComponentToRow } from '../../../lib/data/recipeComponents';
import { rowToOrder, orderToRow, rowToOrderLine, orderLineToRow } from '../../../lib/data/orders';
import { rowToLaborHours, laborHoursToRow } from '../../../lib/data/laborHours';
import { rowToReceipt, receiptToRow, rowToReceiptLine, receiptLineToRow } from '../../../lib/data/receipts';
import { parseBoolean, parseNum, parseEnum } from '../../../lib/types';

// ─── parseBoolean ──────────────────────────────────────────────────────────────

describe('parseBoolean', () => {
  it('returns true for lowercase "true"', () => {
    expect(parseBoolean('true')).toBe(true);
  });

  it('returns true for uppercase "TRUE"', () => {
    expect(parseBoolean('TRUE')).toBe(true);
  });

  it('returns true for mixed case "True"', () => {
    expect(parseBoolean('True')).toBe(true);
  });

  it('returns true for "1"', () => {
    expect(parseBoolean('1')).toBe(true);
  });

  it('returns false for lowercase "false"', () => {
    expect(parseBoolean('false')).toBe(false);
  });

  it('returns false for uppercase "FALSE"', () => {
    expect(parseBoolean('FALSE')).toBe(false);
  });

  it('returns false for "0"', () => {
    expect(parseBoolean('0')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(parseBoolean('')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(parseBoolean(undefined)).toBe(false);
  });

  it('returns false for arbitrary string (no "anything-not-false = true" behaviour)', () => {
    expect(parseBoolean('yes')).toBe(false);
    expect(parseBoolean('1.0')).toBe(false);
  });
});

// ─── parseNum ─────────────────────────────────────────────────────────────────

describe('parseNum', () => {
  it('parses valid integer string', () => {
    expect(parseNum('42')).toBe(42);
  });

  it('parses valid float string', () => {
    expect(parseNum('3.14')).toBeCloseTo(3.14);
  });

  it('returns 0 for empty string', () => {
    expect(parseNum('')).toBe(0);
  });

  it('returns 0 for undefined', () => {
    expect(parseNum(undefined)).toBe(0);
  });

  it('returns 0 for "NaN" string', () => {
    expect(parseNum('NaN')).toBe(0);
  });

  it('returns 0 for non-numeric string', () => {
    expect(parseNum('abc')).toBe(0);
  });

  it('returns 0 for Infinity string', () => {
    expect(parseNum('Infinity')).toBe(0);
  });

  it('uses custom fallback when provided', () => {
    expect(parseNum('abc', -1)).toBe(-1);
  });

  it('returns negative numbers correctly', () => {
    expect(parseNum('-5.5')).toBeCloseTo(-5.5);
  });
});

// ─── parseEnum ────────────────────────────────────────────────────────────────

describe('parseEnum', () => {
  const TXN_TYPES = [
    'receive',
    'transfer_out',
    'transfer_in',
    'consume',
    'yield',
    'sell',
    'count_adjust',
    'waste',
  ] as const;

  it('returns the value when it is in the allowed set', () => {
    expect(parseEnum('receive', TXN_TYPES, 'txn_type')).toBe('receive');
    expect(parseEnum('waste', TXN_TYPES, 'txn_type')).toBe('waste');
  });

  it('throws for an unrecognised value', () => {
    expect(() => parseEnum('unknown', TXN_TYPES, 'txn_type')).toThrow(
      'Invalid txn_type: "unknown"'
    );
  });

  it('throws for undefined', () => {
    expect(() => parseEnum(undefined, TXN_TYPES, 'txn_type')).toThrow(
      'Invalid txn_type: "undefined"'
    );
  });

  it('throws for empty string', () => {
    expect(() => parseEnum('', TXN_TYPES, 'txn_type')).toThrow(
      'Invalid txn_type: ""'
    );
  });

  it('is case-sensitive (enum values are lowercase)', () => {
    expect(() => parseEnum('Receive', TXN_TYPES, 'txn_type')).toThrow();
  });
});

// ─── rowToItem / itemToRow round-trip ─────────────────────────────────────────

describe('rowToItem', () => {
  const baseRow = [
    'item-001',      // item_id
    'Chicken Breast', // name
    'protein',       // category
    'purchased',     // item_type
    'lb',            // base_unit
    'CHK-001',       // barcode_sku
    '3.50',          // default_unit_cost
    'false',         // usda_commodity
    'none',          // allergens
    'USDA-REF-1',    // nutrition_ref
    'vendor-001',    // default_vendor_id
    'true',          // active
  ];

  it('parses all fields correctly', () => {
    const item = rowToItem(baseRow);
    expect(item.item_id).toBe('item-001');
    expect(item.name).toBe('Chicken Breast');
    expect(item.category).toBe('protein');
    expect(item.item_type).toBe('purchased');
    expect(item.base_unit).toBe('lb');
    expect(item.barcode_sku).toBe('CHK-001');
    expect(item.default_unit_cost).toBeCloseTo(3.5);
    expect(item.usda_commodity).toBe(false);
    expect(item.allergens).toBe('none');
    expect(item.nutrition_ref).toBe('USDA-REF-1');
    expect(item.default_vendor_id).toBe('vendor-001');
    expect(item.active).toBe(true);
  });

  it('round-trips: rowToItem → itemToRow → rowToItem produces the same object', () => {
    const item = rowToItem(baseRow);
    const row = itemToRow(item) as string[];
    const item2 = rowToItem(row.map(String));
    expect(item2).toEqual(item);
  });

  it('handles uppercase boolean "TRUE" for usda_commodity', () => {
    const row = [...baseRow];
    row[7] = 'TRUE';
    expect(rowToItem(row).usda_commodity).toBe(true);
  });

  it('handles uppercase boolean "FALSE" for active', () => {
    const row = [...baseRow];
    row[11] = 'FALSE';
    expect(rowToItem(row).active).toBe(false);
  });

  it('handles NaN in default_unit_cost — falls back to 0', () => {
    const row = [...baseRow];
    row[6] = 'not-a-number';
    expect(rowToItem(row).default_unit_cost).toBe(0);
  });

  it('treats missing barcode_sku (empty string) as undefined', () => {
    const row = [...baseRow];
    row[5] = '';
    expect(rowToItem(row).barcode_sku).toBeUndefined();
  });

  it('handles short row (trailing cells missing) without crashing', () => {
    // Simulate a row with only 4 cells (short array from Sheets).
    const short = ['item-002', 'Bread', 'bakery', 'purchased'];
    const item = rowToItem(short);
    expect(item.item_id).toBe('item-002');
    expect(item.base_unit).toBe('');
    expect(item.default_unit_cost).toBe(0);
    expect(item.usda_commodity).toBe(false);
    expect(item.active).toBe(false);
  });

  it('throws for an unrecognised item_type', () => {
    const row = [...baseRow];
    row[3] = 'ingredient';
    expect(() => rowToItem(row)).toThrow('Invalid item_type: "ingredient"');
  });
});

// ─── rowToVendor / vendorToRow round-trip ────────────────────────────────────

describe('rowToVendor', () => {
  const baseRow = [
    'vendor-001',
    'Nicholas and Company',
    'broadline',
    'purchasing@example.com',
    'true',
  ];

  it('round-trips a valid vendor type', () => {
    const vendor = rowToVendor(baseRow);
    const row = vendorToRow(vendor) as string[];
    expect(rowToVendor(row.map(String))).toEqual(vendor);
  });

  it('throws for an unrecognised vendor type', () => {
    const row = [...baseRow];
    row[2] = 'local';
    expect(() => rowToVendor(row)).toThrow('Invalid vendor type: "local"');
  });
});

// ─── rowToLot / lotToRow round-trip ───────────────────────────────────────────

describe('rowToLot', () => {
  const baseRow = [
    'lot-001',      // lot_id
    'item-001',     // item_id
    'loc-001',      // location_id
    '2026-01-10',   // received_date
    '2026-06-10',   // expiration_date
    '100',          // original_qty
    '75.5',         // remaining_qty
    '3.50',         // unit_cost
    'receipt-001',  // source_ref
  ];

  it('parses all fields correctly', () => {
    const lot = rowToLot(baseRow);
    expect(lot.lot_id).toBe('lot-001');
    expect(lot.item_id).toBe('item-001');
    expect(lot.location_id).toBe('loc-001');
    expect(lot.received_date).toBe('2026-01-10');
    expect(lot.expiration_date).toBe('2026-06-10');
    expect(lot.original_qty).toBe(100);
    expect(lot.remaining_qty).toBeCloseTo(75.5);
    expect(lot.unit_cost).toBeCloseTo(3.5);
    expect(lot.source_ref).toBe('receipt-001');
  });

  it('round-trips: rowToLot → lotToRow → rowToLot produces the same object', () => {
    const lot = rowToLot(baseRow);
    const row = lotToRow(lot) as string[];
    const lot2 = rowToLot(row.map(String));
    expect(lot2).toEqual(lot);
  });

  it('treats empty expiration_date cell as undefined', () => {
    const row = [...baseRow];
    row[4] = '';
    expect(rowToLot(row).expiration_date).toBeUndefined();
  });

  it('handles NaN in original_qty — falls back to 0', () => {
    const row = [...baseRow];
    row[5] = 'abc';
    expect(rowToLot(row).original_qty).toBe(0);
  });

  it('handles NaN in remaining_qty — falls back to 0', () => {
    const row = [...baseRow];
    row[6] = '';
    expect(rowToLot(row).remaining_qty).toBe(0);
  });

  it('handles NaN in unit_cost — falls back to 0', () => {
    const row = [...baseRow];
    row[7] = 'NaN';
    expect(rowToLot(row).unit_cost).toBe(0);
  });

  it('handles short row without crashing', () => {
    const short = ['lot-002', 'item-001', 'loc-001'];
    const lot = rowToLot(short);
    expect(lot.lot_id).toBe('lot-002');
    expect(lot.original_qty).toBe(0);
    expect(lot.remaining_qty).toBe(0);
    expect(lot.unit_cost).toBe(0);
    expect(lot.expiration_date).toBeUndefined();
  });
});

// ─── rowToTransaction / transactionToRow round-trip ───────────────────────────

describe('rowToTransaction', () => {
  const baseRow = [
    'txn-001',               // txn_id
    '2026-06-06T00:00:00Z',  // timestamp
    'item-001',              // item_id
    'loc-001',               // location_id
    'lot-001',               // lot_id
    '-10',                   // qty_base (outflow)
    'consume',               // txn_type
    'manual',                // ref_type
    'ref-001',               // ref_id
    '3.50',                  // unit_cost
    'user-001',              // user_id
    'test note',             // note
  ];

  it('parses all fields correctly', () => {
    const txn = rowToTransaction(baseRow);
    expect(txn.txn_id).toBe('txn-001');
    expect(txn.timestamp).toBe('2026-06-06T00:00:00Z');
    expect(txn.item_id).toBe('item-001');
    expect(txn.location_id).toBe('loc-001');
    expect(txn.lot_id).toBe('lot-001');
    expect(txn.qty_base).toBe(-10);
    expect(txn.txn_type).toBe('consume');
    expect(txn.ref_type).toBe('manual');
    expect(txn.ref_id).toBe('ref-001');
    expect(txn.unit_cost).toBeCloseTo(3.5);
    expect(txn.user_id).toBe('user-001');
    expect(txn.note).toBe('test note');
  });

  it('round-trips: rowToTransaction → transactionToRow → rowToTransaction produces the same object', () => {
    const txn = rowToTransaction(baseRow);
    const row = transactionToRow(txn) as string[];
    const txn2 = rowToTransaction(row.map(String));
    expect(txn2).toEqual(txn);
  });

  it('treats empty lot_id as undefined', () => {
    const row = [...baseRow];
    row[4] = '';
    expect(rowToTransaction(row).lot_id).toBeUndefined();
  });

  it('treats empty note as undefined', () => {
    const row = [...baseRow];
    row[11] = '';
    expect(rowToTransaction(row).note).toBeUndefined();
  });

  it('handles NaN in qty_base — falls back to 0', () => {
    const row = [...baseRow];
    row[5] = 'bad';
    expect(rowToTransaction(row).qty_base).toBe(0);
  });

  it('handles NaN in unit_cost — falls back to 0', () => {
    const row = [...baseRow];
    row[9] = '';
    expect(rowToTransaction(row).unit_cost).toBe(0);
  });

  it('throws for unrecognised txn_type — no silent default', () => {
    const row = [...baseRow];
    row[6] = 'invalid_type';
    expect(() => rowToTransaction(row)).toThrow('Invalid txn_type: "invalid_type"');
  });

  it('throws for empty txn_type', () => {
    const row = [...baseRow];
    row[6] = '';
    expect(() => rowToTransaction(row)).toThrow('Invalid txn_type: ""');
  });

  it('parses all valid txn_type values without throwing', () => {
    const validTypes = [
      'receive',
      'transfer_out',
      'transfer_in',
      'consume',
      'yield',
      'sell',
      'count_adjust',
      'waste',
    ];
    for (const t of validTypes) {
      const row = [...baseRow];
      row[6] = t;
      expect(() => rowToTransaction(row)).not.toThrow();
      expect(rowToTransaction(row).txn_type).toBe(t);
    }
  });

  it('handles short row (missing txn_type) by throwing', () => {
    // A row so short that txn_type cell (index 6) is missing → undefined → throw.
    const short = ['txn-002', '2026-01-01T00:00:00Z', 'item-001', 'loc-001', '', '-5'];
    expect(() => rowToTransaction(short)).toThrow('Invalid txn_type');
  });
});

// ─── rowToTransfer — strict enum for status ───────────────────────────────────

describe('rowToTransfer', () => {
  const baseRow = [
    'transfer-001',   // transfer_id
    'loc-001',        // from_location_id
    'loc-002',        // to_location_id
    'in_transit',     // status
    'user-001',       // requested_by
    'user-002',       // approved_by
    '',               // received_by
    '2026-06-01',     // request_date
    '2026-06-05',     // ship_date
    '',               // receive_date
  ];

  it('parses all fields correctly', () => {
    const t = rowToTransfer(baseRow);
    expect(t.transfer_id).toBe('transfer-001');
    expect(t.status).toBe('in_transit');
    expect(t.approved_by).toBe('user-002');
    expect(t.received_by).toBeUndefined();
    expect(t.ship_date).toBe('2026-06-05');
    expect(t.receive_date).toBeUndefined();
  });

  it('throws for unrecognised status', () => {
    const row = [...baseRow];
    row[3] = 'shipped'; // not a valid TransferStatus
    expect(() => rowToTransfer(row)).toThrow('Invalid transfer status: "shipped"');
  });

  it('parses all valid status values without throwing', () => {
    const validStatuses = ['requested', 'approved', 'in_transit', 'received', 'cancelled'];
    for (const s of validStatuses) {
      const row = [...baseRow];
      row[3] = s;
      expect(() => rowToTransfer(row)).not.toThrow();
    }
  });
});

// ─── rowToUnitConversion round-trip ───────────────────────────────────────────

describe('rowToUnitConversion', () => {
  const baseRow = [
    'conv-001',  // conversion_id
    'item-001',  // item_id
    'case',      // from_unit
    '24',        // base_qty_per_unit
    '24 each',   // label
  ];

  it('parses all fields correctly', () => {
    const uc = rowToUnitConversion(baseRow);
    expect(uc.conversion_id).toBe('conv-001');
    expect(uc.item_id).toBe('item-001');
    expect(uc.from_unit).toBe('case');
    expect(uc.base_qty_per_unit).toBe(24);
    expect(uc.label).toBe('24 each');
  });

  it('round-trips correctly', () => {
    const uc = rowToUnitConversion(baseRow);
    const row = unitConversionToRow(uc) as string[];
    const uc2 = rowToUnitConversion(row.map(String));
    expect(uc2).toEqual(uc);
  });

  it('handles NaN in base_qty_per_unit — falls back to 0', () => {
    const row = [...baseRow];
    row[3] = 'abc';
    expect(rowToUnitConversion(row).base_qty_per_unit).toBe(0);
  });
});

// ─── rowToRecipe round-trip ───────────────────────────────────────────────────

describe('rowToRecipe', () => {
  const baseRow = [
    'recipe-001',  // recipe_id
    'item-002',    // produced_item_id
    '50',          // yield_qty
    'serving',     // yield_unit
    '1',           // serving_size
  ];

  it('parses all fields correctly', () => {
    const r = rowToRecipe(baseRow);
    expect(r.recipe_id).toBe('recipe-001');
    expect(r.produced_item_id).toBe('item-002');
    expect(r.yield_qty).toBe(50);
    expect(r.yield_unit).toBe('serving');
    expect(r.serving_size).toBe(1);
  });

  it('round-trips correctly', () => {
    const r = rowToRecipe(baseRow);
    const row = recipeToRow(r) as string[];
    const r2 = rowToRecipe(row.map(String));
    expect(r2).toEqual(r);
  });

  it('handles NaN in yield_qty — falls back to 0', () => {
    const row = [...baseRow];
    row[2] = 'bad';
    expect(rowToRecipe(row).yield_qty).toBe(0);
  });
});

// ─── rowToRecipeComponent round-trip ──────────────────────────────────────────

describe('rowToRecipeComponent', () => {
  const baseRow = [
    'comp-001',   // component_id
    'recipe-001', // recipe_id
    'item-001',   // component_item_id
    '2.5',        // qty
    'lb',         // unit
  ];

  it('parses all fields correctly', () => {
    const rc = rowToRecipeComponent(baseRow);
    expect(rc.component_id).toBe('comp-001');
    expect(rc.recipe_id).toBe('recipe-001');
    expect(rc.component_item_id).toBe('item-001');
    expect(rc.qty).toBeCloseTo(2.5);
    expect(rc.unit).toBe('lb');
  });

  it('round-trips correctly', () => {
    const rc = rowToRecipeComponent(baseRow);
    const row = recipeComponentToRow(rc) as string[];
    const rc2 = rowToRecipeComponent(row.map(String));
    expect(rc2).toEqual(rc);
  });
});

// ─── rowToOrder and rowToOrderLine round-trips ────────────────────────────────

describe('rowToOrder', () => {
  const baseRow = [
    'order-001',    // order_id
    'vendor-001',   // vendor_id
    'loc-001',      // destination_location_id
    '2026-06-01',   // order_date
    '2026-06-10',   // expected_date
    'placed',       // status
  ];

  it('parses all fields correctly', () => {
    const o = rowToOrder(baseRow);
    expect(o.order_id).toBe('order-001');
    expect(o.vendor_id).toBe('vendor-001');
    expect(o.status).toBe('placed');
    expect(o.expected_date).toBe('2026-06-10');
  });

  it('round-trips correctly', () => {
    const o = rowToOrder(baseRow);
    const row = orderToRow(o) as string[];
    const o2 = rowToOrder(row.map(String));
    expect(o2).toEqual(o);
  });

  it('treats empty expected_date as undefined', () => {
    const row = [...baseRow];
    row[4] = '';
    expect(rowToOrder(row).expected_date).toBeUndefined();
  });

  it('throws for unrecognised order status', () => {
    const row = [...baseRow];
    row[5] = 'pending';
    expect(() => rowToOrder(row)).toThrow('Invalid order status: "pending"');
  });

  it('parses all valid order statuses without throwing', () => {
    const valid = ['draft', 'placed', 'partially_received', 'received', 'closed'];
    for (const s of valid) {
      const row = [...baseRow];
      row[5] = s;
      expect(() => rowToOrder(row)).not.toThrow();
    }
  });
});

describe('rowToOrderLine', () => {
  const baseRow = [
    'line-001',   // line_id
    'order-001',  // order_id
    'item-001',   // item_id
    '10',         // qty
    'case',       // unit
    '45.00',      // unit_cost
  ];

  it('parses all fields correctly', () => {
    const line = rowToOrderLine(baseRow);
    expect(line.line_id).toBe('line-001');
    expect(line.qty).toBe(10);
    expect(line.unit_cost).toBeCloseTo(45.0);
  });

  it('round-trips correctly', () => {
    const line = rowToOrderLine(baseRow);
    const row = orderLineToRow(line) as string[];
    const line2 = rowToOrderLine(row.map(String));
    expect(line2).toEqual(line);
  });

  it('handles NaN in qty — falls back to 0', () => {
    const row = [...baseRow];
    row[3] = 'bad';
    expect(rowToOrderLine(row).qty).toBe(0);
  });
});

// ─── rowToLaborHours round-trip ───────────────────────────────────────────────

describe('rowToLaborHours', () => {
  const baseRow = [
    'labor-001',  // labor_id
    'loc-001',    // location_id
    '2026-06-06', // date
    '8.5',        // hours
    'user-001',   // entered_by
  ];

  it('parses all fields correctly', () => {
    const lh = rowToLaborHours(baseRow);
    expect(lh.labor_id).toBe('labor-001');
    expect(lh.location_id).toBe('loc-001');
    expect(lh.date).toBe('2026-06-06');
    expect(lh.hours).toBeCloseTo(8.5);
    expect(lh.entered_by).toBe('user-001');
  });

  it('round-trips correctly', () => {
    const lh = rowToLaborHours(baseRow);
    const row = laborHoursToRow(lh) as string[];
    const lh2 = rowToLaborHours(row.map(String));
    expect(lh2).toEqual(lh);
  });

  it('handles NaN in hours — falls back to 0', () => {
    const row = [...baseRow];
    row[3] = '';
    expect(rowToLaborHours(row).hours).toBe(0);
  });
});

// ─── rowToReceipt and rowToReceiptLine round-trips ────────────────────────────

describe('rowToReceipt', () => {
  const baseRow = [
    'receipt-001',  // receipt_id
    'order-001',    // order_id
    'vendor-001',   // source
    'loc-001',      // location_id
    '2026-06-06',   // receipt_date
    'user-001',     // received_by
  ];

  it('parses all fields correctly', () => {
    const r = rowToReceipt(baseRow);
    expect(r.receipt_id).toBe('receipt-001');
    expect(r.order_id).toBe('order-001');
    expect(r.source).toBe('vendor-001');
  });

  it('treats empty order_id as undefined (blind receive)', () => {
    const row = [...baseRow];
    row[1] = '';
    expect(rowToReceipt(row).order_id).toBeUndefined();
  });

  it('round-trips correctly', () => {
    const r = rowToReceipt(baseRow);
    const row = receiptToRow(r) as string[];
    const r2 = rowToReceipt(row.map(String));
    expect(r2).toEqual(r);
  });
});

describe('rowToReceiptLine', () => {
  const baseRow = [
    'rline-001',    // line_id
    'receipt-001',  // receipt_id
    'item-001',     // item_id
    '48',           // qty_received
    'each',         // unit
    '1.25',         // unit_cost
    '2026-12-31',   // expiration_date
  ];

  it('parses all fields correctly', () => {
    const rl = rowToReceiptLine(baseRow);
    expect(rl.line_id).toBe('rline-001');
    expect(rl.qty_received).toBe(48);
    expect(rl.unit_cost).toBeCloseTo(1.25);
    expect(rl.expiration_date).toBe('2026-12-31');
  });

  it('treats empty expiration_date as undefined', () => {
    const row = [...baseRow];
    row[6] = '';
    expect(rowToReceiptLine(row).expiration_date).toBeUndefined();
  });

  it('round-trips correctly', () => {
    const rl = rowToReceiptLine(baseRow);
    const row = receiptLineToRow(rl) as string[];
    const rl2 = rowToReceiptLine(row.map(String));
    expect(rl2).toEqual(rl);
  });

  it('handles NaN in qty_received — falls back to 0', () => {
    const row = [...baseRow];
    row[3] = 'NaN';
    expect(rowToReceiptLine(row).qty_received).toBe(0);
  });

  it('handles NaN in unit_cost — falls back to 0', () => {
    const row = [...baseRow];
    row[5] = 'Infinity';
    expect(rowToReceiptLine(row).unit_cost).toBe(0);
  });
});
