import 'server-only';

/**
 * recipes.ts — service for recipe cost calculation and production runs.
 *
 * Rules:
 *  - Recipes are global (not location-scoped) but production runs are location-scoped.
 *  - Planning cost uses item.default_unit_cost for each component.
 *  - Actual cost uses FIFO weighted-average lot cost at the location, falling back
 *    to default_unit_cost when no lots exist.
 *  - runProduction consumes ingredients via consumeFIFO (FIFO, APPEND-ONLY ledger)
 *    then creates a new produced lot and posts a 'yield' transaction.
 *  - All quantities are in base units — no conversion here.
 */

import { getAllRecipes } from '../data/recipes';
import { getAllRecipeComponents } from '../data/recipeComponents';
import { getAllItems } from '../data/items';
import { getAllLots, createLot } from '../data/lots';
import { consumeFIFO, postTransaction } from './inventory';
import { assertValidSession, requireAssignedLocation, requireRole } from './authorization';
import { NotFoundError, ValidationError } from './errors';
import type { Session } from '../types';
import { Role } from '../types';

// ─── Public input / result types ─────────────────────────────────────────────

export interface RunProductionInput {
  recipeId: string;
  locationId: string;
  /** Number of recipe yields to produce (e.g. 2 = make the recipe twice). */
  multiplier: number;
  note?: string;
}

export interface RunProductionResult {
  producedLotId: string;
  totalCost: number;
  costPerUnit: number;
}

// ─── getPlanningCost ──────────────────────────────────────────────────────────

/**
 * Returns the theoretical cost per serving and total cost of a recipe using
 * each component item's default_unit_cost.
 *
 * Recipes are global (not location-scoped), so only basic session validation
 * is performed (no location access check).
 */
export async function getPlanningCost(
  recipeId: string,
  session: Session
): Promise<{ costPerServing: number; totalCost: number }> {
  assertValidSession(session);

  // Load recipe.
  const allRecipes = await getAllRecipes();
  const recipe = allRecipes.find((r) => r.recipe_id === recipeId);
  if (!recipe) {
    throw new NotFoundError(`Recipe not found: ${recipeId}`);
  }

  // Load components for this recipe.
  const allComponents = await getAllRecipeComponents();
  const components = allComponents.filter((c) => c.recipe_id === recipeId);

  // Load all items for cost lookup.
  const allItems = await getAllItems();
  const itemMap = new Map(allItems.map((i) => [i.item_id, i]));

  // Compute total cost: Σ(component.qty × item.default_unit_cost).
  let totalCost = 0;
  for (const component of components) {
    const item = itemMap.get(component.component_item_id);
    if (!item) {
      throw new NotFoundError(
        `Item not found for component ${component.component_id}: ${component.component_item_id}`
      );
    }
    totalCost += component.qty * item.default_unit_cost;
  }

  const costPerServing = recipe.serving_size > 0 ? totalCost / recipe.serving_size : 0;

  return { costPerServing, totalCost };
}

// ─── getActualCost ────────────────────────────────────────────────────────────

/**
 * Returns the actual cost per serving and total cost at a specific location,
 * using FIFO weighted-average lot costs instead of default_unit_cost.
 *
 * Falls back to item.default_unit_cost when no lots with remaining stock
 * exist at the location for a given component item.
 */
export async function getActualCost(
  recipeId: string,
  locationId: string,
  session: Session
): Promise<{ costPerServing: number; totalCost: number }> {
  requireAssignedLocation(session, locationId);

  // Load recipe.
  const allRecipes = await getAllRecipes();
  const recipe = allRecipes.find((r) => r.recipe_id === recipeId);
  if (!recipe) {
    throw new NotFoundError(`Recipe not found: ${recipeId}`);
  }

  // Load components for this recipe.
  const allComponents = await getAllRecipeComponents();
  const components = allComponents.filter((c) => c.recipe_id === recipeId);

  // Load all items and lots.
  const allItems = await getAllItems();
  const itemMap = new Map(allItems.map((i) => [i.item_id, i]));

  const allLots = await getAllLots();

  // Compute total cost using FIFO weighted-average lot cost per component.
  let totalCost = 0;
  for (const component of components) {
    const item = itemMap.get(component.component_item_id);
    if (!item) {
      throw new NotFoundError(
        `Item not found for component ${component.component_id}: ${component.component_item_id}`
      );
    }

    // Find active lots for this item+location, oldest first.
    const activeLots = allLots
      .filter(
        (l) =>
          l.item_id === component.component_item_id &&
          l.location_id === locationId &&
          l.remaining_qty > 0
      )
      .sort((a, b) => {
        if (a.received_date < b.received_date) return -1;
        if (a.received_date > b.received_date) return 1;
        return a.lot_id.localeCompare(b.lot_id);
      });

    let effectiveCost: number;
    if (activeLots.length === 0) {
      // Fall back to default_unit_cost when no stock exists.
      effectiveCost = item.default_unit_cost;
    } else {
      // FIFO weighted-average: Σ(lot.remaining_qty × lot.unit_cost) / Σ(lot.remaining_qty).
      const totalQty = activeLots.reduce((sum, l) => sum + l.remaining_qty, 0);
      const totalValue = activeLots.reduce(
        (sum, l) => sum + l.remaining_qty * l.unit_cost,
        0
      );
      effectiveCost = totalQty > 0 ? totalValue / totalQty : item.default_unit_cost;
    }

    totalCost += component.qty * effectiveCost;
  }

  const costPerServing = recipe.serving_size > 0 ? totalCost / recipe.serving_size : 0;

  return { costPerServing, totalCost };
}

// ─── runProduction ────────────────────────────────────────────────────────────

/**
 * Executes a production run for a recipe at a location.
 *
 * Steps:
 *  1. Validate multiplier (must be positive finite).
 *  2. Load recipe, throw NotFoundError if missing.
 *  3. Require session to have location access.
 *  4. For each component, consumeFIFO the required qty (× multiplier).
 *  5. Compute total cost from consumed lots.
 *  6. Create a new Lot for the produced item.
 *  7. Post a 'yield' transaction.
 *  8. Return { producedLotId, totalCost, costPerUnit }.
 */
export async function runProduction(
  input: RunProductionInput,
  session: Session
): Promise<RunProductionResult> {
  const { recipeId, locationId, multiplier, note } = input;

  // 1. Validate multiplier.
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new ValidationError(
      `multiplier must be a positive finite number, got ${multiplier}`
    );
  }

  // 2. Load recipe.
  const allRecipes = await getAllRecipes();
  const recipe = allRecipes.find((r) => r.recipe_id === recipeId);
  if (!recipe) {
    throw new NotFoundError(`Recipe not found: ${recipeId}`);
  }

  // 3. Access check — production is location-scoped.
  requireRole(session, [Role.director_admin, Role.warehouse, Role.kitchen_manager]);
  requireAssignedLocation(session, locationId);

  // 4. Load components for this recipe.
  const allComponents = await getAllRecipeComponents();
  const components = allComponents.filter((c) => c.recipe_id === recipeId);

  // 5. Consume each component via FIFO and accumulate total cost.
  let totalConsumedCost = 0;

  for (const component of components) {
    const qtyToConsume = component.qty * multiplier;

    const { lotConsumed } = await consumeFIFO({
      itemId: component.component_item_id,
      locationId,
      qty: qtyToConsume,
      txnType: 'consume',
      refType: 'manual',
      refId: recipeId,
      note,
      session,
    });

    // Accumulate cost: Σ(lotConsumed[i].qty × lotConsumed[i].unitCost).
    for (const lc of lotConsumed) {
      totalConsumedCost += lc.qty * lc.unitCost;
    }
  }

  // 6. Create the produced lot.
  const yieldQty = recipe.yield_qty * multiplier;
  const unit_cost = yieldQty > 0 ? totalConsumedCost / yieldQty : 0;
  const today = new Date().toISOString().slice(0, 10);

  const newLot = await createLot({
    item_id: recipe.produced_item_id,
    location_id: locationId,
    received_date: today,
    original_qty: yieldQty,
    remaining_qty: yieldQty,
    unit_cost,
    source_ref: recipeId,
  });

  // 7. Post a 'yield' transaction (positive inflow for the produced item).
  await postTransaction(
    {
      item_id: recipe.produced_item_id,
      location_id: locationId,
      lot_id: newLot.lot_id,
      qty_base: yieldQty,
      txn_type: 'yield',
      ref_type: 'manual',
      ref_id: recipeId,
      unit_cost,
      note,
    },
    session
  );

  // 8. Return result.
  return {
    producedLotId: newLot.lot_id,
    totalCost: totalConsumedCost,
    costPerUnit: unit_cost,
  };
}
