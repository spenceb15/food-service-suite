import 'server-only';

import { Role } from '../types';
import type { Session } from '../types';
import { UnauthorizedError } from '../services/errors';

/**
 * Development stub session — returns a director_admin with access to all
 * locations. This will be replaced by real NextAuth/Google Workspace auth
 * once the auth module is built.
 *
 * DO NOT use this in production code paths. Gate it behind
 * process.env.NODE_ENV checks or replace it entirely before going live.
 */
export async function getSession(): Promise<Session> {
  if (
    process.env.NODE_ENV !== 'development' &&
    process.env.NODE_ENV !== 'test'
  ) {
    throw new UnauthorizedError('Development auth stub is unavailable');
  }

  return {
    userId: 'stub-director-001',
    role: Role.director_admin,
    // 'all' signals unrestricted location access for this dev stub.
    // When real auth is wired, this will be a string[] from the User record.
    assignedLocationIds: 'all',
  };
}
