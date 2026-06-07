import 'server-only';

import { randomUUID } from 'node:crypto';
import { getRows, appendRow } from './sheets';
import { parseNum } from '../types';
import type { LaborHours } from '../types';

// Tab: LaborHours
// Column order (0-based):
// labor_id, location_id, date, hours, entered_by

const TAB = 'LaborHours';

function rowToLaborHours(row: string[]): LaborHours {
  return {
    labor_id: row[0] ?? '',
    location_id: row[1] ?? '',
    date: row[2] ?? '',
    hours: parseNum(row[3]),
    entered_by: row[4] ?? '',
  };
}

function laborHoursToRow(lh: LaborHours): unknown[] {
  return [
    lh.labor_id,
    lh.location_id,
    lh.date,
    lh.hours,
    lh.entered_by,
  ];
}

export { rowToLaborHours, laborHoursToRow };

export async function getAllLaborHours(): Promise<LaborHours[]> {
  const rows = await getRows(TAB);
  return rows.filter((r) => r[0] !== '').map(rowToLaborHours);
}

export async function createLaborHours(
  data: Omit<LaborHours, 'labor_id'>
): Promise<LaborHours> {
  const lh: LaborHours = { labor_id: randomUUID(), ...data };
  await appendRow(TAB, laborHoursToRow(lh));
  return lh;
}
