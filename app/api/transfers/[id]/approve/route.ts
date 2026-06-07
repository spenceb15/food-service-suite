import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '../../../../../lib/auth/stub';
import { approveTransfer } from '../../../../../lib/services/transfers';
import { serviceErrorResponse } from '../../../../../lib/api/serviceResponse';

/**
 * PATCH /api/transfers/[id]/approve
 *
 * Advances a transfer from 'requested' to 'approved'. Only director_admin may
 * call this endpoint; the service enforces the role gate.
 */
export async function PATCH(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const session = await getSession();
    const transfer = await approveTransfer(id, session);
    return NextResponse.json(transfer, { status: 200 });
  } catch (err) {
    return serviceErrorResponse(err);
  }
}
