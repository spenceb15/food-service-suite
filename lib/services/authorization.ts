import type { Session } from '../types';
import { Role } from '../types';
import { ForbiddenError, UnauthorizedError } from './errors';

const ALL_OPERATION_ROLES: readonly Role[] = [
  Role.director_admin,
  Role.warehouse,
  Role.kitchen_manager,
  Role.vending_route,
  Role.private_site,
];

const SITE_ROLES: readonly Role[] = [
  Role.kitchen_manager,
  Role.vending_route,
  Role.private_site,
];

export function assertValidSession(session: Session): void {
  if (!session.userId.trim()) {
    throw new UnauthorizedError('A valid user session is required');
  }

  if (
    session.assignedLocationIds === 'all' &&
    session.role !== Role.director_admin
  ) {
    throw new ForbiddenError(
      'Only director administrators may access all locations'
    );
  }
}

export function requireRole(
  session: Session,
  allowedRoles: readonly Role[]
): void {
  assertValidSession(session);

  if (!allowedRoles.includes(session.role)) {
    throw new ForbiddenError('Role is not permitted for this operation');
  }
}

export function requireAssignedLocation(
  session: Session,
  locationId: string
): void {
  assertValidSession(session);

  if (
    session.assignedLocationIds !== 'all' &&
    !session.assignedLocationIds.includes(locationId)
  ) {
    throw new ForbiddenError('Location is not assigned to this user');
  }
}

export function requireDirectorEndpointAccess(
  session: Session,
  fromLocationId: string,
  toLocationId: string
): void {
  requireRole(session, [Role.director_admin]);
  requireAssignedLocation(session, fromLocationId);
  requireAssignedLocation(session, toLocationId);
}

export function requireReceiveDeliveryAccess(
  session: Session,
  destinationLocationId: string
): void {
  requireRole(session, ALL_OPERATION_ROLES);
  requireAssignedLocation(session, destinationLocationId);
}

export function requireRequestTransferAccess(
  session: Session,
  sourceLocationId: string,
  destinationLocationId: string
): void {
  requireRole(session, ALL_OPERATION_ROLES);

  if (session.role === Role.director_admin) {
    requireDirectorEndpointAccess(
      session,
      sourceLocationId,
      destinationLocationId
    );
    return;
  }

  if (session.role === Role.warehouse) {
    requireAssignedLocation(session, sourceLocationId);
    return;
  }

  if (SITE_ROLES.includes(session.role)) {
    requireAssignedLocation(session, destinationLocationId);
  }
}

export function requireApproveTransferAccess(
  session: Session,
  sourceLocationId: string,
  destinationLocationId: string
): void {
  requireDirectorEndpointAccess(
    session,
    sourceLocationId,
    destinationLocationId
  );
}

export function requireShipTransferAccess(
  session: Session,
  sourceLocationId: string
): void {
  requireRole(session, [Role.director_admin, Role.warehouse]);
  requireAssignedLocation(session, sourceLocationId);
}

export function requireReceiveTransferAccess(
  session: Session,
  destinationLocationId: string
): void {
  requireRole(session, ALL_OPERATION_ROLES);
  requireAssignedLocation(session, destinationLocationId);
}
