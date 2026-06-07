import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '../../../../../lib/auth/stub';
import { receiveTransfer } from '../../../../../lib/services/transfers';
import { serviceErrorResponse } from '../../../../../lib/api/serviceResponse';

/**
 * PATCH /api/transfers/[id]/receive
 *
 * Advances a transfer from 'in_transit' to 'received'. Recreates lots at the
 * destination carrying the source unit_cost, and posts transfer_in transactions.
 * The caller's session must include the destination location.
 */
export async function PATCH(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const session = await getSession();
    const transfer = await receiveTransfer(id, session);
    return NextResponse.json(transfer, { status: 200 });
  } catch (err) {
    return serviceErrorResponse(err);
  }
}
