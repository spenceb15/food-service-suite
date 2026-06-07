import 'server-only';

/**
 * laborHours.ts — service for recording and querying labor hours.
 *
 * MPLH (Meals Per Labor Hour) meal-equivalent computation is deferred to the
 * Schools module per the spec. This service only handles raw hours data.
 */

import { getAllLaborHours, createLaborHours } from '../data/laborHours';
import { requireAssignedLocation, requireRole } from './authorization';
import { ValidationError } from './errors';
import type { LaborHours, Session } from '../types';
import { Role } from '../types';

// ─── Public input types ───────────────────────────────────────────────────────

export interface EnterLaborHoursInput {
  locationId: string;
  /** ISO YYYY-MM-DD */
  date: string;
  /** Must be a positive finite number. */
  hours: number;
}

// ─── enterLaborHours ──────────────────────────────────────────────────────────

/**
 * Records a labor hours entry for a location on a given date.
 *
 * Access: director_admin, warehouse, or kitchen_manager only.
 * Validates hours (positive finite), date (YYYY-MM-DD), and non-empty locationId.
 */
export async function enterLaborHours(
  input: EnterLaborHoursInput,
  session: Session
): Promise<LaborHours> {
  const { locationId, date, hours } = input;

  // Access + role check first.
  requireRole(session, [Role.director_admin, Role.warehouse, Role.kitchen_manager]);
  requireAssignedLocation(session, locationId);

  // Validate locationId.
  if (!locationId || !locationId.trim()) {
    throw new ValidationError('locationId must be non-empty');
  }

  // Validate date format.
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ValidationError('date must be in ISO format YYYY-MM-DD');
  }

  // Validate hours.
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new ValidationError(
      `hours must be a positive finite number, got ${hours}`
    );
  }

  return createLaborHours({
    location_id: locationId,
    date,
    hours,
    entered_by: session.userId,
  });
}

// ─── getLaborHours ────────────────────────────────────────────────────────────

/**
 * Returns labor hours entries for a location, optionally filtered to a single date.
 * Results are sorted by date descending.
 *
 * @param locationId  Required — only entries matching this location are returned.
 * @param date        Optional ISO YYYY-MM-DD — when provided, results are further
 *                    filtered to that date only.
 */
export async function getLaborHours(
  locationId: string,
  date: string | undefined,
  session: Session
): Promise<LaborHours[]> {
  requireAssignedLocation(session, locationId);

  const allEntries = await getAllLaborHours();

  let filtered = allEntries.filter((e) => e.location_id === locationId);

  if (date) {
    filtered = filtered.filter((e) => e.date === date);
  }

  // Sort descending by date.
  filtered.sort((a, b) => {
    if (a.date > b.date) return -1;
    if (a.date < b.date) return 1;
    return 0;
  });

  return filtered;
}

// ─── getMPLH ─────────────────────────────────────────────────────────────────

/**
 * Returns the total labor hours logged for a location+date.
 *
 * Meal-equivalent computation (MPLH = meals / labor hours) is deferred to the
 * Schools module — only raw labor hours are returned here.
 */
export async function getMPLH(
  locationId: string,
  date: string,
  session: Session
): Promise<{ laborHours: number; note: string }> {
  requireAssignedLocation(session, locationId);

  const entries = await getLaborHours(locationId, date, session);
  const totalHours = entries.reduce((sum, e) => sum + e.hours, 0);

  return {
    laborHours: totalHours,
    note: 'Meal equivalents require Schools module',
  };
}
