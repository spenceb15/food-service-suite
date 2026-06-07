import { afterEach, describe, expect, it, vi } from 'vitest';
import { Role } from '../../../lib/types';
import { getSession } from '../../../lib/auth/stub';
import { UnauthorizedError } from '../../../lib/services/errors';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getSession development stub', () => {
  it('remains available in test', async () => {
    vi.stubEnv('NODE_ENV', 'test');

    await expect(getSession()).resolves.toEqual({
      userId: 'stub-director-001',
      role: Role.director_admin,
      assignedLocationIds: 'all',
    });
  });

  it('fails closed in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    await expect(getSession()).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(getSession()).rejects.toMatchObject({
      status: 401,
    });
  });
});
