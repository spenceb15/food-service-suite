import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { Role } from '../../../lib/types';
import type { Session } from '../../../lib/types';
import { UnauthorizedError } from '../../../lib/services/errors';

vi.mock('../../../lib/auth/stub', () => ({
  getSession: vi.fn(),
}));

vi.mock('../../../lib/services/receiving', () => ({
  receiveDelivery: vi.fn(),
}));

vi.mock('../../../lib/services/transfers', () => ({
  requestTransfer: vi.fn(),
}));

import { getSession } from '../../../lib/auth/stub';
import { receiveDelivery } from '../../../lib/services/receiving';
import { requestTransfer } from '../../../lib/services/transfers';
import { POST as postReceipt } from '../../../app/api/receipts/route';
import { POST as postTransfer } from '../../../app/api/transfers/route';

const validSession: Session = {
  userId: 'director-1',
  role: Role.director_admin,
  assignedLocationIds: 'all',
};

function malformedRequest(): {
  request: NextRequest;
  json: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn().mockRejectedValue(new SyntaxError('Unexpected token'));
  return {
    request: { json } as unknown as NextRequest,
    json,
  };
}

function validRequest(body: unknown = {}): NextRequest {
  return {
    json: vi.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.mocked(getSession).mockReset();
  vi.mocked(receiveDelivery).mockReset();
  vi.mocked(requestTransfer).mockReset();
});

describe('POST route authentication order', () => {
  it('returns 401 for an unauthenticated receipt request before parsing malformed JSON', async () => {
    vi.mocked(getSession).mockRejectedValue(
      new UnauthorizedError('Production session unavailable')
    );
    const { request, json } = malformedRequest();

    const response = await postReceipt(request);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(json).not.toHaveBeenCalled();
    expect(receiveDelivery).not.toHaveBeenCalled();
  });

  it('returns 401 for an unauthenticated transfer request before parsing malformed JSON', async () => {
    vi.mocked(getSession).mockRejectedValue(
      new UnauthorizedError('Production session unavailable')
    );
    const { request, json } = malformedRequest();

    const response = await postTransfer(request);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(json).not.toHaveBeenCalled();
    expect(requestTransfer).not.toHaveBeenCalled();
  });
});

describe('POST route JSON error boundaries', () => {
  it.each([
    ['receipt', postReceipt],
    ['transfer', postTransfer],
  ])(
    'returns 400 for malformed %s JSON after authentication succeeds',
    async (_name, handler) => {
      vi.mocked(getSession).mockResolvedValue(validSession);
      const { request, json } = malformedRequest();

      const response = await handler(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'Invalid JSON body',
      });
      expect(json).toHaveBeenCalledOnce();
    }
  );

  it('maps a downstream receipt service SyntaxError to generic 500', async () => {
    vi.mocked(getSession).mockResolvedValue(validSession);
    vi.mocked(receiveDelivery).mockRejectedValue(
      new SyntaxError('Unexpected downstream syntax')
    );

    const response = await postReceipt(validRequest({ locationId: 'school-1' }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Internal server error',
    });
  });

  it('maps a downstream transfer service SyntaxError to generic 500', async () => {
    vi.mocked(getSession).mockResolvedValue(validSession);
    vi.mocked(requestTransfer).mockRejectedValue(
      new SyntaxError('Unexpected downstream syntax')
    );

    const response = await postTransfer(
      validRequest({ fromLocationId: 'warehouse-1' })
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Internal server error',
    });
  });
});
