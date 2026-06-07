/**
 * Unit tests for lib/services/laborHours.ts
 *
 * All I/O is mocked. No real network calls are made.
 *
 * Coverage:
 *  enterLaborHours:
 *    - Happy path: creates and returns the labor hours record
 *    - Invalid hours: 0, negative, NaN → ValidationError
 *    - Invalid date format: non-YYYY-MM-DD → ValidationError
 *    - Forbidden role: vending_route / private_site cannot enter hours
 *    - Access denied: session without the target location
 *
 *  getLaborHours:
 *    - Returns all entries filtered to the location
 *    - Returns entries filtered to location + date
 *    - Returns empty array when nothing matches
 *    - Sorted by date descending
 *
 *  getMPLH:
 *    - Sums labor hours correctly for a given location+date
 *    - Always returns the deferred-Schools-module note
 *    - Returns 0 when no entries
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Role } from '../../../lib/types';
import type { Session, LaborHours } from '../../../lib/types';

// ─── Mocks (hoisted by Vitest) ────────────────────────────────────────────────

vi.mock('../../../lib/data/laborHours', () => ({
  getAllLaborHours: vi.fn(),
  createLaborHours: vi.fn(),
}));

// Import mocked module so we can configure return values per test.
import { getAllLaborHours, createLaborHours } from '../../../lib/data/laborHours';

// Import service under test AFTER mocks.
import {
  enterLaborHours,
  getLaborHours,
  getMPLH,
} from '../../../lib/services/laborHours';

// ─── Stub sessions ────────────────────────────────────────────────────────────

const adminSession: Session = {
  userId: 'user-admin',
  role: Role.director_admin,
  assignedLocationIds: 'all',
};

const warehouseSession: Session = {
  userId: 'user-warehouse',
  role: Role.warehouse,
  assignedLocationIds: ['loc-001'],
};

const kitchenSession: Session = {
  userId: 'user-kitchen',
  role: Role.kitchen_manager,
  assignedLocationIds: ['loc-001'],
};

const vendingSession: Session = {
  userId: 'user-vending',
  role: Role.vending_route,
  assignedLocationIds: ['loc-001'],
};

const privateSiteSession: Session = {
  userId: 'user-private',
  role: Role.private_site,
  assignedLocationIds: ['loc-001'],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<LaborHours> = {}): LaborHours {
  return {
    labor_id: 'lh-001',
    location_id: 'loc-001',
    date: '2026-06-06',
    hours: 8,
    entered_by: 'user-admin',
    ...overrides,
  };
}

// ─── beforeEach ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(createLaborHours).mockResolvedValue(makeEntry());
  vi.mocked(getAllLaborHours).mockResolvedValue([makeEntry()]);
});

// ─── enterLaborHours — happy path ─────────────────────────────────────────────

describe('enterLaborHours — happy path', () => {
  it('creates and returns a LaborHours record', async () => {
    const result = await enterLaborHours(
      { locationId: 'loc-001', date: '2026-06-06', hours: 8 },
      adminSession
    );
    expect(createLaborHours).toHaveBeenCalledOnce();
    expect(result.labor_id).toBe('lh-001');
    expect(result.hours).toBe(8);
  });

  it('passes the correct fields to createLaborHours', async () => {
    await enterLaborHours(
      { locationId: 'loc-001', date: '2026-06-10', hours: 6.5 },
      adminSession
    );

    const arg = vi.mocked(createLaborHours).mock.calls[0][0];
    expect(arg.location_id).toBe('loc-001');
    expect(arg.date).toBe('2026-06-10');
    expect(arg.hours).toBe(6.5);
    // entered_by must be derived from session, not caller-supplied.
    expect(arg.entered_by).toBe('user-admin');
  });

  it('succeeds with warehouse role', async () => {
    await expect(
      enterLaborHours({ locationId: 'loc-001', date: '2026-06-06', hours: 7 }, warehouseSession)
    ).resolves.toBeDefined();
    expect(createLaborHours).toHaveBeenCalledOnce();
  });

  it('succeeds with kitchen_manager role', async () => {
    await expect(
      enterLaborHours({ locationId: 'loc-001', date: '2026-06-06', hours: 7 }, kitchenSession)
    ).resolves.toBeDefined();
    expect(createLaborHours).toHaveBeenCalledOnce();
  });
});

// ─── enterLaborHours — invalid hours ─────────────────────────────────────────

describe('enterLaborHours — invalid hours', () => {
  it('throws ValidationError when hours is 0', async () => {
    await expect(
      enterLaborHours({ locationId: 'loc-001', date: '2026-06-06', hours: 0 }, adminSession)
    ).rejects.toThrow('hours must be a positive finite number');
    expect(createLaborHours).not.toHaveBeenCalled();
  });

  it('throws ValidationError when hours is negative', async () => {
    await expect(
      enterLaborHours({ locationId: 'loc-001', date: '2026-06-06', hours: -3 }, adminSession)
    ).rejects.toThrow('hours must be a positive finite number');
    expect(createLaborHours).not.toHaveBeenCalled();
  });

  it('throws ValidationError when hours is NaN', async () => {
    await expect(
      enterLaborHours({ locationId: 'loc-001', date: '2026-06-06', hours: NaN }, adminSession)
    ).rejects.toThrow('hours must be a positive finite number');
    expect(createLaborHours).not.toHaveBeenCalled();
  });

  it('throws ValidationError when hours is Infinity', async () => {
    await expect(
      enterLaborHours({ locationId: 'loc-001', date: '2026-06-06', hours: Infinity }, adminSession)
    ).rejects.toThrow('hours must be a positive finite number');
    expect(createLaborHours).not.toHaveBeenCalled();
  });
});

// ─── enterLaborHours — invalid date ──────────────────────────────────────────

describe('enterLaborHours — invalid date format', () => {
  it('throws ValidationError for MM/DD/YYYY format', async () => {
    await expect(
      enterLaborHours({ locationId: 'loc-001', date: '06/06/2026', hours: 8 }, adminSession)
    ).rejects.toThrow('date must be in ISO format YYYY-MM-DD');
    expect(createLaborHours).not.toHaveBeenCalled();
  });

  it('throws ValidationError for empty date', async () => {
    await expect(
      enterLaborHours({ locationId: 'loc-001', date: '', hours: 8 }, adminSession)
    ).rejects.toThrow('date must be in ISO format YYYY-MM-DD');
    expect(createLaborHours).not.toHaveBeenCalled();
  });

  it('throws ValidationError for date without dashes', async () => {
    await expect(
      enterLaborHours({ locationId: 'loc-001', date: '20260606', hours: 8 }, adminSession)
    ).rejects.toThrow('date must be in ISO format YYYY-MM-DD');
    expect(createLaborHours).not.toHaveBeenCalled();
  });
});

// ─── enterLaborHours — forbidden roles ───────────────────────────────────────

describe('enterLaborHours — forbidden roles', () => {
  it('throws ForbiddenError when role is vending_route', async () => {
    await expect(
      enterLaborHours({ locationId: 'loc-001', date: '2026-06-06', hours: 8 }, vendingSession)
    ).rejects.toThrow();
    expect(createLaborHours).not.toHaveBeenCalled();
  });

  it('throws ForbiddenError when role is private_site', async () => {
    await expect(
      enterLaborHours({ locationId: 'loc-001', date: '2026-06-06', hours: 8 }, privateSiteSession)
    ).rejects.toThrow();
    expect(createLaborHours).not.toHaveBeenCalled();
  });
});

// ─── enterLaborHours — access denied ─────────────────────────────────────────

describe('enterLaborHours — access denied', () => {
  it('throws when session does not include the target location', async () => {
    const restrictedSession: Session = {
      userId: 'user-x',
      role: Role.kitchen_manager,
      assignedLocationIds: ['loc-999'],
    };
    await expect(
      enterLaborHours({ locationId: 'loc-001', date: '2026-06-06', hours: 8 }, restrictedSession)
    ).rejects.toThrow();
    expect(createLaborHours).not.toHaveBeenCalled();
  });
});

// ─── getLaborHours — filtering ────────────────────────────────────────────────

describe('getLaborHours — filtering', () => {
  it('returns all entries for the location when no date is specified', async () => {
    vi.mocked(getAllLaborHours).mockResolvedValue([
      makeEntry({ labor_id: 'lh-1', date: '2026-06-05' }),
      makeEntry({ labor_id: 'lh-2', date: '2026-06-06' }),
      makeEntry({ labor_id: 'lh-3', location_id: 'loc-999', date: '2026-06-06' }), // different location
    ]);

    const result = await getLaborHours('loc-001', undefined, adminSession);
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.location_id === 'loc-001')).toBe(true);
  });

  it('filters to location + date when date is provided', async () => {
    vi.mocked(getAllLaborHours).mockResolvedValue([
      makeEntry({ labor_id: 'lh-1', date: '2026-06-05' }),
      makeEntry({ labor_id: 'lh-2', date: '2026-06-06' }),
      makeEntry({ labor_id: 'lh-3', date: '2026-06-06' }),
    ]);

    const result = await getLaborHours('loc-001', '2026-06-06', adminSession);
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.date === '2026-06-06')).toBe(true);
  });

  it('returns empty array when no entries match', async () => {
    vi.mocked(getAllLaborHours).mockResolvedValue([
      makeEntry({ location_id: 'loc-999' }),
    ]);

    const result = await getLaborHours('loc-001', undefined, adminSession);
    expect(result).toHaveLength(0);
  });

  it('sorts results by date descending', async () => {
    vi.mocked(getAllLaborHours).mockResolvedValue([
      makeEntry({ labor_id: 'lh-1', date: '2026-06-01' }),
      makeEntry({ labor_id: 'lh-2', date: '2026-06-06' }),
      makeEntry({ labor_id: 'lh-3', date: '2026-06-03' }),
    ]);

    const result = await getLaborHours('loc-001', undefined, adminSession);
    expect(result[0].date).toBe('2026-06-06');
    expect(result[1].date).toBe('2026-06-03');
    expect(result[2].date).toBe('2026-06-01');
  });
});

// ─── getMPLH ─────────────────────────────────────────────────────────────────

describe('getMPLH', () => {
  it('sums labor hours correctly for location + date', async () => {
    vi.mocked(getAllLaborHours).mockResolvedValue([
      makeEntry({ labor_id: 'lh-1', date: '2026-06-06', hours: 3.5 }),
      makeEntry({ labor_id: 'lh-2', date: '2026-06-06', hours: 4.5 }),
      makeEntry({ labor_id: 'lh-3', date: '2026-06-05', hours: 8 }), // different date
    ]);

    const result = await getMPLH('loc-001', '2026-06-06', adminSession);
    expect(result.laborHours).toBeCloseTo(8.0);
  });

  it('returns 0 when no entries exist for location+date', async () => {
    vi.mocked(getAllLaborHours).mockResolvedValue([]);
    const result = await getMPLH('loc-001', '2026-06-06', adminSession);
    expect(result.laborHours).toBe(0);
  });

  it('always includes the Schools-module deferred note', async () => {
    const result = await getMPLH('loc-001', '2026-06-06', adminSession);
    expect(result.note).toBe('Meal equivalents require Schools module');
  });

  it('throws when session does not include the target location', async () => {
    const restrictedSession: Session = {
      userId: 'user-x',
      role: Role.kitchen_manager,
      assignedLocationIds: ['loc-999'],
    };
    await expect(
      getMPLH('loc-001', '2026-06-06', restrictedSession)
    ).rejects.toThrow();
  });
});
