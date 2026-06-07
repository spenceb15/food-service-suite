import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '../../../lib/auth/stub';
import { getAllLocations, createLocation } from '../../../lib/data/locations';
import { serviceErrorResponse } from '../../../lib/api/serviceResponse';
import { requireRole } from '../../../lib/services/authorization';
import { ValidationError } from '../../../lib/services/errors';
import { ClientType, Role } from '../../../lib/types';

const CLIENT_TYPES: readonly ClientType[] = [
  ClientType.Warehouse,
  ClientType.School,
  ClientType.Vending,
  ClientType.Private,
];

const ALL_ROLES = Object.values(Role) as Role[];

/**
 * GET /api/locations
 *
 * Returns active locations scoped to the session's assignedLocationIds.
 * director_admin (assignedLocationIds === 'all') sees all active locations.
 */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession();
    requireRole(session, ALL_ROLES);

    const all = await getAllLocations();
    const active = all.filter((l) => l.active);

    if (session.assignedLocationIds === 'all') {
      return NextResponse.json(active, { status: 200 });
    }

    const scoped = active.filter((l) =>
      (session.assignedLocationIds as string[]).includes(l.location_id)
    );
    return NextResponse.json(scoped, { status: 200 });
  } catch (err) {
    return serviceErrorResponse(err);
  }
}

/**
 * POST /api/locations
 *
 * Creates a new location. Only director_admin may call this endpoint.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession();
    requireRole(session, [Role.director_admin]);

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch (err) {
      if (err instanceof SyntaxError) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      throw err;
    }

    const { name, client_type, address, active } = body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new ValidationError('name must be a non-empty string');
    }
    if (!client_type || !CLIENT_TYPES.includes(client_type as ClientType)) {
      throw new ValidationError(
        `client_type must be one of: ${CLIENT_TYPES.join(', ')}`
      );
    }
    if (typeof address !== 'string') {
      throw new ValidationError('address must be a string');
    }
    if (typeof active !== 'boolean') {
      throw new ValidationError('active must be a boolean');
    }

    const location = await createLocation({
      name: (name as string).trim(),
      client_type: client_type as ClientType,
      address: address.trim(),
      active,
    });

    return NextResponse.json(location, { status: 201 });
  } catch (err) {
    return serviceErrorResponse(err);
  }
}
