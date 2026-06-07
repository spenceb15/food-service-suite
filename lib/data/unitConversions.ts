import 'server-only';

import { randomUUID } from 'node:crypto';
import { getRows, appendRow } from './sheets';
import { parseNum } from '../types';
import type { UnitConversion } from '../types';

// Tab: UnitConversions
// Column order (0-based):
// conversion_id, item_id, from_unit, base_qty_per_unit, label

const TAB = 'UnitConversions';

function rowToUnitConversion(row: string[]): UnitConversion {
  return {
    conversion_id: row[0] ?? '',
    item_id: row[1] ?? '',
    from_unit: row[2] ?? '',
    base_qty_per_unit: parseNum(row[3]),
    label: row[4] ?? '',
  };
}

function unitConversionToRow(uc: UnitConversion): unknown[] {
  return [
    uc.conversion_id,
    uc.item_id,
    uc.from_unit,
    uc.base_qty_per_unit,
    uc.label,
  ];
}

export { rowToUnitConversion, unitConversionToRow };

export async function getAllUnitConversions(): Promise<UnitConversion[]> {
  const rows = await getRows(TAB);
  return rows.filter((r) => r[0] !== '').map(rowToUnitConversion);
}

export async function createUnitConversion(
  data: Omit<UnitConversion, 'conversion_id'>
): Promise<UnitConversion> {
  const uc: UnitConversion = { conversion_id: randomUUID(), ...data };
  await appendRow(TAB, unitConversionToRow(uc));
  return uc;
}
