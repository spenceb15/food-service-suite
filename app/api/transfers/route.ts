import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '../../../lib/auth/stub';
import { getAllTransfers } from '../../../lib/data/transfers';
import { requestTransfer } from '../../../lib/services/transfers';
import { serviceErrorResponse } from '../../../lib/api/serviceResponse';
import { requireRole } from '../../../lib/services/authorization';
import { Role } from '../../../lib/types';
import type { TransferStatus } from '../../../lib/types';

const ALL_ROLES = Object.values(Role) as Role[];

/**
 * GET /api/transfers
 *
 * Returns transfers visible to the session's assignedLocationIds
 * (a transfer is visible if from_location_id OR to_location_id matches).
 *
 * Supports optional ?status= query param to filter by TransferStatus.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession();
    requireRole(session, ALL_ROLES);

    const { searchParams } = new URL(request.url);
    const statusFilter = searchParams.get('status') as TransferStatus | null;

    let transfers = await getAllTransfers();

    if (session.assignedLocationIds !== 'all') {
      const ids = session.assignedLocationIds as string[];
      transfers = transfers.filter(
        (t) =>
          ids.includes(t.from_location_id) || ids.includes(t.to_location_id)
      );
    }

    if (statusFilter) {
      transfers = transfers.filter((t) => t.status === statusFilter);
    }

    return NextResponse.json(transfers, { status: 200 });
  } catch (err) {
    return serviceErrorResponse(err);
  }
}

/**
 * POST /api/transfers
 *
 * Creates a new transfer request. Delegates all business logic and validation
 * to requestTransfer() in lib/services/transfers.ts.
 *
 * Security notes:
 *  - Google service-account credentials never leave the server (they live in
 *    the data layer, accessed only through lib/data/).
 *  - No stack traces, Sheets IDs, or internal messages are surfaced in error
 *    responses.
 *  - Session is resolved server-side via getSession(); the client never
 *    supplies a user identity.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession();
    let body: Parameters<typeof requestTransfer>[0];
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
    const transfer = await requestTransfer(body, session);
    return NextResponse.json(transfer, { status: 201 });
  } catch (err) {
    return serviceErrorResponse(err);
  }
}
