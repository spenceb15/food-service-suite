import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '../../../../../lib/auth/stub';
import { shipTransfer } from '../../../../../lib/services/transfers';
import { serviceErrorResponse } from '../../../../../lib/api/serviceResponse';

/**
 * PATCH /api/transfers/[id]/ship
 *
 * Advances a transfer from 'approved' to 'in_transit'. Consumes stock at the
 * source location via FIFO (transfer_out transactions). The caller's session
 * must include the source location.
 */
export async function PATCH(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const session = await getSession();
    const transfer = await shipTransfer(id, session);
    return NextResponse.json(transfer, { status: 200 });
  } catch (err) {
    return serviceErrorResponse(err);
  }
}
