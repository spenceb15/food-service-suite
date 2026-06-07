import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '../../../lib/auth/stub';
import { getAllReceipts } from '../../../lib/data/receipts';
import { receiveDelivery } from '../../../lib/services/receiving';
import { serviceErrorResponse } from '../../../lib/api/serviceResponse';
import { requireRole } from '../../../lib/services/authorization';
import { Role } from '../../../lib/types';

const ALL_ROLES = Object.values(Role) as Role[];

/**
 * GET /api/receipts
 *
 * Returns receipts scoped to the session's assignedLocationIds.
 */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession();
    requireRole(session, ALL_ROLES);

    const receipts = await getAllReceipts();

    if (session.assignedLocationIds === 'all') {
      return NextResponse.json(receipts, { status: 200 });
    }

    const scoped = receipts.filter((r) =>
      (session.assignedLocationIds as string[]).includes(r.location_id)
    );
    return NextResponse.json(scoped, { status: 200 });
  } catch (err) {
    return serviceErrorResponse(err);
  }
}

/**
 * POST /api/receipts
 *
 * Records an inbound delivery.  Delegates all business logic and validation
 * to receiveDelivery() in lib/services/receiving.ts.
 *
 * Security notes:
 *  - Google service-account credentials never leave the server (they live in
 *    the data layer, accessed only through lib/data/).
 *  - No stack traces, Sheets IDs, or internal messages are surfaced in 4xx/5xx
 *    responses.
 *  - Session is resolved server-side via getSession(); the client never
 *    supplies a user identity.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession();
    let body: Parameters<typeof receiveDelivery>[0];
    try {
      body = await request.json();
    } catch (err) {
      if (err instanceof SyntaxError) {
        return NextResponse.json(
          { error: 'Invalid JSON body' },
          { status: 400 }
        );
      }
      throw err;
    }
    const receipt = await receiveDelivery(body, session);
    return NextResponse.json(receipt, { status: 201 });
  } catch (err) {
    return serviceErrorResponse(err);
  }
}
