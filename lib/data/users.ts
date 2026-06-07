import 'server-only';

import { randomUUID } from 'node:crypto';
import { getRows, appendRow } from './sheets';
import { Role } from '../types';
import type { User } from '../types';

// Tab column order (0-based):
// user_id, name, email, role, assigned_location_ids (comma-separated)

const TAB = 'Users';

const ROLES: readonly Role[] = [
  Role.director_admin,
  Role.warehouse,
  Role.kitchen_manager,
  Role.vending_route,
  Role.private_site,
];

function rowToUser(row: string[]): User {
  const rawRole = row[3] as Role | undefined;
  const role: Role = ROLES.includes(rawRole as Role)
    ? (rawRole as Role)
    : (() => {
        console.warn(`Unknown role "${row[3]}", defaulting to "warehouse"`);
        return Role.warehouse;
      })();

  const rawLocations = row[4] ?? '';
  return {
    user_id: row[0] ?? '',
    name: row[1] ?? '',
    email: row[2] ?? '',
    role,
    assigned_location_ids: rawLocations
      ? rawLocations.split(',').map((s) => s.trim()).filter(Boolean)
      : [],
  };
}

function userToRow(user: User): unknown[] {
  return [
    user.user_id,
    user.name,
    user.email,
    user.role,
    user.assigned_location_ids.join(','),
  ];
}

export async function getAllUsers(): Promise<User[]> {
  const rows = await getRows(TAB);
  return rows.filter((r) => r[0] !== '').map(rowToUser);
}

export async function createUser(data: Omit<User, 'user_id'>): Promise<User> {
  const user: User = { user_id: randomUUID(), ...data };
  await appendRow(TAB, userToRow(user));
  return user;
}
