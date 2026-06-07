import 'server-only';

import { randomUUID } from 'node:crypto';
import { getRows, appendRow } from './sheets';
import { parseBoolean, parseEnum, parseNum } from '../types';
import type { Item, ItemType } from '../types';

// Tab column order (0-based):
// item_id, name, category, item_type, base_unit, barcode_sku,
// default_unit_cost, usda_commodity, allergens, nutrition_ref,
// default_vendor_id, active

const TAB = 'Items';

const ITEM_TYPES: readonly ItemType[] = ['purchased', 'produced', 'retail'];

function rowToItem(row: string[]): Item {
  const item_type = parseEnum(
    row[3]?.toLowerCase(),
    ITEM_TYPES,
    'item_type'
  );

  return {
    item_id: row[0] ?? '',
    name: row[1] ?? '',
    category: row[2] ?? '',
    item_type,
    base_unit: row[4] ?? '',
    barcode_sku: (row[5] ?? '') !== '' ? row[5] : undefined,
    default_unit_cost: parseNum(row[6]),
    usda_commodity: parseBoolean(row[7]),
    allergens: (row[8] ?? '') !== '' ? row[8] : undefined,
    nutrition_ref: (row[9] ?? '') !== '' ? row[9] : undefined,
    default_vendor_id: (row[10] ?? '') !== '' ? row[10] : undefined,
    active: parseBoolean(row[11]),
  };
}

function itemToRow(item: Item): unknown[] {
  return [
    item.item_id,
    item.name,
    item.category,
    item.item_type,
    item.base_unit,
    item.barcode_sku ?? '',
    item.default_unit_cost,
    item.usda_commodity ? 'true' : 'false',
    item.allergens ?? '',
    item.nutrition_ref ?? '',
    item.default_vendor_id ?? '',
    item.active ? 'true' : 'false',
  ];
}

export { rowToItem, itemToRow };

export async function getAllItems(): Promise<Item[]> {
  const rows = await getRows(TAB);
  return rows.filter((r) => r[0] !== '').map(rowToItem);
}

export async function createItem(data: Omit<Item, 'item_id'>): Promise<Item> {
  const item: Item = { item_id: randomUUID(), ...data };
  await appendRow(TAB, itemToRow(item));
  return item;
}
