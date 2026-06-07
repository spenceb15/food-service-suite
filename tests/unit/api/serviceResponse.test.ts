import { describe, expect, it } from 'vitest';
import { serviceErrorResponse } from '../../../lib/api/serviceResponse';
import {
  ForbiddenError,
  IdempotencyConflictError,
  IntegrityConflictError,
  NotFoundError,
  RetryableMutationError,
  UnauthorizedError,
  ValidationError,
} from '../../../lib/services/errors';

async function expectResponse(
  error: unknown,
  status: number,
  message: string
): Promise<void> {
  const response = serviceErrorResponse(error);

  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual({ error: message });
}

describe('serviceErrorResponse', () => {
  it('hides unauthorized details behind a safe 401 message', async () => {
    await expectResponse(
      new UnauthorizedError('production auth stub unavailable'),
      401,
      'Unauthorized'
    );
  });

  it('hides forbidden details behind a safe 403 message', async () => {
    await expectResponse(
      new ForbiddenError('location school-secret is not assigned'),
      403,
      'Forbidden'
    );
  });

  it.each([
    [new ValidationError('quantity must be positive'), 400],
    [new NotFoundError('Transfer not found'), 404],
    [new IdempotencyConflictError('Receipt payload changed'), 409],
    [new IntegrityConflictError('Transfer manifest is incomplete'), 409],
  ])('retains the safe message for %s', async (error, status) => {
    await expectResponse(error, status, error.message);
  });

  it('returns a safe retry instruction for retryable failures', async () => {
    await expectResponse(
      new RetryableMutationError('Sheets row 42 is ambiguous'),
      503,
      'Please retry the same operation.'
    );
  });

  it('maps arbitrary syntax errors to a generic 500', async () => {
    await expectResponse(
      new SyntaxError('Unexpected token'),
      500,
      'Internal server error'
    );
  });

  it('maps unknown errors to a generic 500', async () => {
    await expectResponse(new Error('credential details'), 500, 'Internal server error');
  });
});
