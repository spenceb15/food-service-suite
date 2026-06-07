import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '../../../lib/auth/stub';
import {
  getAllOrders,
  createOrder,
  createOrderLine,
} from '../../../lib/data/orders';
import { serviceErrorResponse } from '../../../lib/api/serviceResponse';
import { requireRole } from '../../../lib/services/authorization';
import { ValidationError } from '../../../lib/services/errors';
import { Role } from '../../../lib/types';

const ALL_ROLES = Object.values(Role) as Role[];

/**
 * GET /api/orders
 *
 * Returns orders scoped to the session's assignedLocationIds
 * (filtered on destination_location_id).
 */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession();
    requireRole(session, ALL_ROLES);

    const orders = await getAllOrders();

    if (session.assignedLocationIds === 'all') {
      return NextResponse.json(orders, { status: 200 });
    }

    const scoped = orders.filter((o) =>
      (session.assignedLocationIds as string[]).includes(
        o.destination_location_id
      )
    );
    return NextResponse.json(scoped, { status: 200 });
  } catch (err) {
    return serviceErrorResponse(err);
  }
}

interface OrderLineInput {
  item_id: string;
  qty: number;
  unit: string;
  unit_cost: number;
}

/**
 * POST /api/orders
 *
 * Creates a purchase order with one or more lines.
 * Only director_admin may create orders.
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

    const { vendor_id, destination_location_id, order_date, expected_date, lines } = body;

    if (!vendor_id || typeof vendor_id !== 'string' || !vendor_id.trim()) {
      throw new ValidationError('vendor_id must be a non-empty string');
    }
    if (
      !destination_location_id ||
      typeof destination_location_id !== 'string' ||
      !destination_location_id.trim()
    ) {
      throw new ValidationError(
        'destination_location_id must be a non-empty string'
      );
    }
    if (!order_date || typeof order_date !== 'string' || !order_date.trim()) {
      throw new ValidationError('order_date must be a non-empty string');
    }
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new ValidationError('lines must be a non-empty array');
    }

    // Validate each line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as Record<string, unknown>;
      if (!line.item_id || typeof line.item_id !== 'string' || !line.item_id.trim()) {
        throw new ValidationError(`lines[${i}].item_id must be a non-empty string`);
      }
      if (
        typeof line.qty !== 'number' ||
        !Number.isFinite(line.qty) ||
        line.qty <= 0
      ) {
        throw new ValidationError(`lines[${i}].qty must be a positive finite number`);
      }
      if (!line.unit || typeof line.unit !== 'string' || !line.unit.trim()) {
        throw new ValidationError(`lines[${i}].unit must be a non-empty string`);
      }
      if (
        typeof line.unit_cost !== 'number' ||
        !Number.isFinite(line.unit_cost) ||
        line.unit_cost < 0
      ) {
        throw new ValidationError(
          `lines[${i}].unit_cost must be a non-negative finite number`
        );
      }
    }

    const order = await createOrder({
      vendor_id: (vendor_id as string).trim(),
      destination_location_id: (destination_location_id as string).trim(),
      order_date: (order_date as string).trim(),
      expected_date:
        typeof expected_date === 'string' && expected_date.trim()
          ? expected_date.trim()
          : undefined,
      status: 'draft',
    });

    const createdLines = await Promise.all(
      (lines as OrderLineInput[]).map((l) =>
        createOrderLine({
          order_id: order.order_id,
          item_id: l.item_id.trim(),
          qty: l.qty,
          unit: l.unit.trim(),
          unit_cost: l.unit_cost,
        })
      )
    );

    return NextResponse.json({ order, lines: createdLines }, { status: 201 });
  } catch (err) {
    return serviceErrorResponse(err);
  }
}
