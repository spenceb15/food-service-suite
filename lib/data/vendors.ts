import 'server-only';

import { randomUUID } from 'node:crypto';
import { getRows, appendRow } from './sheets';
import { parseBoolean, parseEnum } from '../types';
import type { Vendor, VendorType } from '../types';

// Tab column order (0-based):
// vendor_id, name, type, contact, active

const TAB = 'Vendors';

const VENDOR_TYPES: readonly VendorType[] = ['broadline', 'produce', 'other'];

function rowToVendor(row: string[]): Vendor {
  const type = parseEnum(row[2]?.toLowerCase(), VENDOR_TYPES, 'vendor type');

  return {
    vendor_id: row[0] ?? '',
    name: row[1] ?? '',
    type,
    contact: row[3] ?? '',
    active: parseBoolean(row[4]),
  };
}

function vendorToRow(vendor: Vendor): unknown[] {
  return [
    vendor.vendor_id,
    vendor.name,
    vendor.type,
    vendor.contact,
    vendor.active ? 'true' : 'false',
  ];
}

export { rowToVendor, vendorToRow };

export async function getAllVendors(): Promise<Vendor[]> {
  const rows = await getRows(TAB);
  return rows.filter((r) => r[0] !== '').map(rowToVendor);
}

export async function createVendor(
  data: Omit<Vendor, 'vendor_id'>
): Promise<Vendor> {
  const vendor: Vendor = { vendor_id: randomUUID(), ...data };
  await appendRow(TAB, vendorToRow(vendor));
  return vendor;
}
