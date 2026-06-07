import { describe, expect, it } from 'vitest';
import { Role } from '../../../lib/types';
import type { Session } from '../../../lib/types';
import {
  assertValidSession,
  requireApproveTransferAccess,
  requireAssignedLocation,
  requireDirectorEndpointAccess,
  requireReceiveDeliveryAccess,
  requireReceiveTransferAccess,
  requireRequestTransferAccess,
  requireRole,
  requireShipTransferAccess,
} from '../../../lib/services/authorization';
import {
  ForbiddenError,
  IdempotencyConflictError,
  IntegrityConflictError,
  RetryableMutationError,
  UnauthorizedError,
} from '../../../lib/services/errors';

function session(
  role: Role,
  assignedLocationIds: string[] | 'all',
  userId = 'user-1'
): Session {
  return { userId, role, assignedLocationIds };
}

describe('service error statuses', () => {
  it('assigns the required HTTP statuses', () => {
    expect(new UnauthorizedError('missing session').status).toBe(401);
    expect(new IdempotencyConflictError('changed payload').status).toBe(409);
    expect(new IntegrityConflictError('bad ledger').status).toBe(409);
    expect(new RetryableMutationError('retry').status).toBe(503);
  });
});

describe('assertValidSession', () => {
  it('rejects a blank user ID as unauthorized', () => {
    expect(() =>
      assertValidSession(
        session(Role.kitchen_manager, ['school-1'], '   ')
      )
    ).toThrow(UnauthorizedError);
  });

  it('rejects all-location access for a non-director', () => {
    expect(() =>
      assertValidSession(session(Role.kitchen_manager, 'all'))
    ).toThrow(ForbiddenError);
  });

  it('allows a director to have all-location access', () => {
    expect(() =>
      assertValidSession(session(Role.director_admin, 'all'))
    ).not.toThrow();
  });
});

describe('reusable authorization helpers', () => {
  it('requires an allowed role', () => {
    expect(() =>
      requireRole(session(Role.kitchen_manager, ['school-1']), [
        Role.warehouse,
      ])
    ).toThrow(ForbiddenError);
  });

  it('requires an assigned location unless the director has all access', () => {
    expect(() =>
      requireAssignedLocation(
        session(Role.warehouse, ['warehouse-1']),
        'school-1'
      )
    ).toThrow(ForbiddenError);

    expect(() =>
      requireAssignedLocation(
        session(Role.director_admin, 'all'),
        'school-1'
      )
    ).not.toThrow();
  });

  it('requires a director to have both transfer endpoints', () => {
    expect(() =>
      requireDirectorEndpointAccess(
        session(Role.director_admin, ['warehouse-1']),
        'warehouse-1',
        'school-1'
      )
    ).toThrow(ForbiddenError);

    expect(() =>
      requireDirectorEndpointAccess(
        session(Role.director_admin, ['warehouse-1', 'school-1']),
        'warehouse-1',
        'school-1'
      )
    ).not.toThrow();
  });
});

describe('operation authorization policies', () => {
  it.each([
    Role.director_admin,
    Role.warehouse,
    Role.kitchen_manager,
    Role.vending_route,
    Role.private_site,
  ])('allows %s to receive a delivery at an assigned destination', (role) => {
    expect(() =>
      requireReceiveDeliveryAccess(session(role, ['school-1']), 'school-1')
    ).not.toThrow();
  });

  it('allows a site role assigned only to the destination to request a transfer', () => {
    expect(() =>
      requireRequestTransferAccess(
        session(Role.kitchen_manager, ['school-1']),
        'warehouse-1',
        'school-1'
      )
    ).not.toThrow();
  });

  it('requires warehouse requesters to have source access', () => {
    expect(() =>
      requireRequestTransferAccess(
        session(Role.warehouse, ['warehouse-1']),
        'warehouse-1',
        'school-1'
      )
    ).not.toThrow();

    expect(() =>
      requireRequestTransferAccess(
        session(Role.warehouse, ['warehouse-2']),
        'warehouse-1',
        'school-1'
      )
    ).toThrow(ForbiddenError);
  });

  it('requires a scoped director requester to have both endpoints', () => {
    expect(() =>
      requireRequestTransferAccess(
        session(Role.director_admin, ['warehouse-1']),
        'warehouse-1',
        'school-1'
      )
    ).toThrow(ForbiddenError);

    expect(() =>
      requireRequestTransferAccess(
        session(Role.director_admin, 'all'),
        'warehouse-1',
        'school-1'
      )
    ).not.toThrow();
  });

  it('restricts approval to directors with both endpoints unless all', () => {
    expect(() =>
      requireApproveTransferAccess(
        session(Role.warehouse, ['warehouse-1', 'school-1']),
        'warehouse-1',
        'school-1'
      )
    ).toThrow(ForbiddenError);

    expect(() =>
      requireApproveTransferAccess(
        session(Role.director_admin, ['warehouse-1']),
        'warehouse-1',
        'school-1'
      )
    ).toThrow(ForbiddenError);

    expect(() =>
      requireApproveTransferAccess(
        session(Role.director_admin, 'all'),
        'warehouse-1',
        'school-1'
      )
    ).not.toThrow();
  });

  it('allows a source-assigned warehouse user to ship to an unassigned destination', () => {
    expect(() =>
      requireShipTransferAccess(
        session(Role.warehouse, ['warehouse-1']),
        'warehouse-1'
      )
    ).not.toThrow();
  });

  it('does not allow a kitchen manager to ship', () => {
    expect(() =>
      requireShipTransferAccess(
        session(Role.kitchen_manager, ['warehouse-1']),
        'warehouse-1'
      )
    ).toThrow(ForbiddenError);
  });

  it('allows all listed roles to receive a transfer only at an assigned destination', () => {
    expect(() =>
      requireReceiveTransferAccess(
        session(Role.kitchen_manager, ['school-1']),
        'school-1'
      )
    ).not.toThrow();

    expect(() =>
      requireReceiveTransferAccess(
        session(Role.warehouse, ['warehouse-1']),
        'school-1'
      )
    ).toThrow(ForbiddenError);
  });
});
