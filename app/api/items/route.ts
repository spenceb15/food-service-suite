import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '../../../lib/auth/stub';
import { getAllItems, createItem } from '../../../lib/data/items';
import { serviceErrorResponse } from '../../../lib/api/serviceResponse';
import { requireRole } from '../../../lib/services/authorization';
import { ValidationError } from '../../../lib/services/errors';
import { Role } from '../../../lib/types';
import type { ItemType } from '../../../lib/types';

const ITEM_TYPES: readonly ItemType[] = ['purchased', 'produced', 'retail'];
const VALID_ROLES = Object.values(Role) as Role[];

/**
 * GET /api/items
 *
 * Returns all active items. Accessible to all authenticated roles.
 */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession();
    requireRole(session, VALID_ROLES);
    const items = await getAllItems();
    return NextResponse.json(
      items.filter((i) => i.active),
      { status: 200 }
    );
  } catch (err) {
    return serviceErrorResponse(err);
  }
}

/**
 * POST /api/items
 *
 * Creates a new item. Only director_admin may call this endpoint.
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

    const { name, category, item_type, base_unit, default_unit_cost, active } = body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new ValidationError('name must be a non-empty string');
    }
    if (!category || typeof category !== 'string' || !category.trim()) {
      throw new ValidationError('category must be a non-empty string');
    }
    if (!item_type || !ITEM_TYPES.includes(item_type as ItemType)) {
      throw new ValidationError(
        `item_type must be one of: ${ITEM_TYPES.join(', ')}`
      );
    }
    if (!base_unit || typeof base_unit !== 'string' || !base_unit.trim()) {
      throw new ValidationError('base_unit must be a non-empty string');
    }
    if (
      typeof default_unit_cost !== 'number' ||
      !Number.isFinite(default_unit_cost) ||
      default_unit_cost < 0
    ) {
      throw new ValidationError(
        'default_unit_cost must be a non-negative finite number'
      );
    }
    if (typeof active !== 'boolean') {
      throw new ValidationError('active must be a boolean');
    }

    const item = await createItem({
      name: (name as string).trim(),
      category: (category as string).trim(),
      item_type: item_type as ItemType,
      base_unit: (base_unit as string).trim(),
      barcode_sku:
        typeof body.barcode_sku === 'string' && body.barcode_sku.trim()
          ? body.barcode_sku.trim()
          : undefined,
      default_unit_cost: default_unit_cost as number,
      usda_commodity:
        typeof body.usda_commodity === 'boolean' ? body.usda_commodity : false,
      allergens:
        typeof body.allergens === 'string' && body.allergens.trim()
          ? body.allergens.trim()
          : undefined,
      nutrition_ref:
        typeof body.nutrition_ref === 'string' && body.nutrition_ref.trim()
          ? body.nutrition_ref.trim()
          : undefined,
      default_vendor_id:
        typeof body.default_vendor_id === 'string' && body.default_vendor_id.trim()
          ? body.default_vendor_id.trim()
          : undefined,
      active,
    });

    return NextResponse.json(item, { status: 201 });
  } catch (err) {
    return serviceErrorResponse(err);
  }
}
