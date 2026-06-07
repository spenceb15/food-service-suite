import 'server-only';

import { randomUUID } from 'node:crypto';
import { getRows, appendRow } from './sheets';
import { parseBoolean, ClientType } from '../types';
import type { Location } from '../types';

// Tab column order (0-based):
// location_id, name, client_type, address, active

const TAB = 'Locations';

const CLIENT_TYPES: readonly ClientType[] = [
  ClientType.Warehouse,
  ClientType.School,
  ClientType.Vending,
  ClientType.Private,
];

function rowToLocation(row: string[]): Location {
  const rawType = row[2] as ClientType | undefined;
  const client_type: ClientType = CLIENT_TYPES.includes(rawType as ClientType)
    ? (rawType as ClientType)
    : (() => {
        console.warn(`Unknown client_type "${row[2]}", defaulting to Warehouse`);
        return ClientType.Warehouse;
      })();

  return {
    location_id: row[0] ?? '',
    name: row[1] ?? '',
    client_type,
    address: row[3] ?? '',
    active: parseBoolean(row[4]),
  };
}

function locationToRow(location: Location): unknown[] {
  return [
    location.location_id,
    location.name,
    location.client_type,
    location.address,
    location.active ? 'true' : 'false',
  ];
}

export { rowToLocation, locationToRow };

export async function getAllLocations(): Promise<Location[]> {
  const rows = await getRows(TAB);
  return rows.filter((r) => r[0] !== '').map(rowToLocation);
}

export async function createLocation(
  data: Omit<Location, 'location_id'>
): Promise<Location> {
  const location: Location = { location_id: randomUUID(), ...data };
  await appendRow(TAB, locationToRow(location));
  return location;
}
