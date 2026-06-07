import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '../../../lib/auth/stub';
import { getAllUsers, createUser } from '../../../lib/data/users';
import { serviceErrorResponse } from '../../../lib/api/serviceResponse';
import { requireRole } from '../../../lib/services/authorization';
import { ValidationError } from '../../../lib/services/errors';
import { Role } from '../../../lib/types';

const VALID_ROLES = Object.values(Role) as Role[];

/**
 * GET /api/users
 *
 * Returns all users. Only director_admin may call this endpoint.
 */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession();
    requireRole(session, [Role.director_admin]);
    const users = await getAllUsers();
    return NextResponse.json(users, { status: 200 });
  } catch (err) {
    return serviceErrorResponse(err);
  }
}

/**
 * POST /api/users
 *
 * Creates a new user. Only director_admin may call this endpoint.
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

    const { name, email, role, assigned_location_ids } = body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new ValidationError('name must be a non-empty string');
    }
    if (!email || typeof email !== 'string' || !email.trim()) {
      throw new ValidationError('email must be a non-empty string');
    }
    if (!role || !VALID_ROLES.includes(role as Role)) {
      throw new ValidationError(
        `role must be one of: ${VALID_ROLES.join(', ')}`
      );
    }
    if (!Array.isArray(assigned_location_ids)) {
      throw new ValidationError('assigned_location_ids must be an array');
    }
    if (
      !assigned_location_ids.every(
        (id) => typeof id === 'string' && id.trim()
      )
    ) {
      throw new ValidationError(
        'assigned_location_ids must be an array of non-empty strings'
      );
    }

    const user = await createUser({
      name: (name as string).trim(),
      email: (email as string).trim(),
      role: role as Role,
      assigned_location_ids: (assigned_location_ids as string[]).map((id) =>
        id.trim()
      ),
    });

    return NextResponse.json(user, { status: 201 });
  } catch (err) {
    return serviceErrorResponse(err);
  }
}
