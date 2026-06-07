import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '../../../lib/auth/stub';
import { getAllVendors, createVendor } from '../../../lib/data/vendors';
import { serviceErrorResponse } from '../../../lib/api/serviceResponse';
import { requireRole } from '../../../lib/services/authorization';
import { ValidationError } from '../../../lib/services/errors';
import { Role } from '../../../lib/types';
import type { VendorType } from '../../../lib/types';

const VENDOR_TYPES: readonly VendorType[] = ['broadline', 'produce', 'other'];
const ALL_ROLES = Object.values(Role) as Role[];

/**
 * GET /api/vendors
 *
 * Returns all active vendors. Accessible to all authenticated roles.
 */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession();
    requireRole(session, ALL_ROLES);
    const vendors = await getAllVendors();
    return NextResponse.json(
      vendors.filter((v) => v.active),
      { status: 200 }
    );
  } catch (err) {
    return serviceErrorResponse(err);
  }
}

/**
 * POST /api/vendors
 *
 * Creates a new vendor. Only director_admin may call this endpoint.
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

    const { name, type, contact, active } = body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new ValidationError('name must be a non-empty string');
    }
    if (!type || !VENDOR_TYPES.includes(type as VendorType)) {
      throw new ValidationError(
        `type must be one of: ${VENDOR_TYPES.join(', ')}`
      );
    }
    if (typeof contact !== 'string') {
      throw new ValidationError('contact must be a string');
    }
    if (typeof active !== 'boolean') {
      throw new ValidationError('active must be a boolean');
    }

    const vendor = await createVendor({
      name: (name as string).trim(),
      type: type as VendorType,
      contact: contact.trim(),
      active,
    });

    return NextResponse.json(vendor, { status: 201 });
  } catch (err) {
    return serviceErrorResponse(err);
  }
}
