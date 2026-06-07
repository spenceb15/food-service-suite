/**
 * Unit tests for lib/services/recipes.ts
 *
 * All I/O is mocked. No real network calls are made.
 *
 * Coverage:
 *  getPlanningCost:
 *    - Happy path: correct math (totalCost and costPerServing)
 *    - NotFoundError when recipe not found
 *    - Session validation (empty userId → UnauthorizedError)
 *
 *  getActualCost:
 *    - Happy path: uses FIFO weighted-average lot cost
 *    - Falls back to default_unit_cost when no lots with remaining stock exist
 *    - NotFoundError when recipe not found
 *
 *  runProduction:
 *    - Happy path: correct consumeFIFO calls, lot created, yield transaction posted
 *    - multiplier validation (0, negative, NaN, Infinity → ValidationError)
 *    - NotFoundError when recipe not found
 *    - Forbidden when role is insufficient
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Role } from '../../../lib/types';
import type { Session, Recipe, RecipeComponent, Item, Lot } from '../../../lib/types';

// ─── Mocks (hoisted by Vitest) ────────────────────────────────────────────────

vi.mock('../../../lib/data/recipes', () => ({
  getAllRecipes: vi.fn(),
}));

vi.mock('../../../lib/data/recipeComponents', () => ({
  getAllRecipeComponents: vi.fn(),
}));

vi.mock('../../../lib/data/items', () => ({
  getAllItems: vi.fn(),
}));

vi.mock('../../../lib/data/lots', () => ({
  getAllLots: vi.fn(),
  createLot: vi.fn(),
  updateLot: vi.fn(),
}));

vi.mock('../../../lib/services/inventory', () => ({
  consumeFIFO: vi.fn(),
  postTransaction: vi.fn(),
}));

// Import mocked modules so we can configure return values per test.
import { getAllRecipes } from '../../../lib/data/recipes';
import { getAllRecipeComponents } from '../../../lib/data/recipeComponents';
import { getAllItems } from '../../../lib/data/items';
import { getAllLots, createLot } from '../../../lib/data/lots';
import { consumeFIFO, postTransaction } from '../../../lib/services/inventory';

// Import service under test AFTER mocks.
import {
  getPlanningCost,
  getActualCost,
  runProduction,
} from '../../../lib/services/recipes';

// ─── Stub data ────────────────────────────────────────────────────────────────

const adminSession: Session = {
  userId: 'user-1',
  role: Role.director_admin,
  assignedLocationIds: 'all',
};

const kitchenSession: Session = {
  userId: 'user-2',
  role: Role.kitchen_manager,
  assignedLocationIds: ['loc-001'],
};

const vendingSession: Session = {
  userId: 'user-3',
  role: Role.vending_route,
  assignedLocationIds: ['loc-001'],
};

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    recipe_id: 'recipe-001',
    produced_item_id: 'item-produced',
    yield_qty: 10,      // 10 base units produced per run
    yield_unit: 'serving',
    serving_size: 5,    // 5 base units per serving
    ...overrides,
  };
}

function makeComponent(overrides: Partial<RecipeComponent> = {}): RecipeComponent {
  return {
    component_id: 'comp-001',
    recipe_id: 'recipe-001',
    component_item_id: 'item-001',
    qty: 2,             // 2 base units per recipe
    unit: 'each',
    ...overrides,
  };
}

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    item_id: 'item-001',
    name: 'Test Item',
    category: 'pantry',
    item_type: 'purchased',
    base_unit: 'each',
    default_unit_cost: 3.0,
    usda_commodity: false,
    active: true,
    ...overrides,
  };
}

function makeLot(overrides: Partial<Lot> = {}): Lot {
  return {
    lot_id: 'lot-001',
    item_id: 'item-001',
    location_id: 'loc-001',
    received_date: '2026-01-01',
    original_qty: 100,
    remaining_qty: 100,
    unit_cost: 2.5,
    source_ref: 'receipt-001',
    ...overrides,
  };
}

// ─── beforeEach ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Default happy-path data.
  vi.mocked(getAllRecipes).mockResolvedValue([makeRecipe()]);
  vi.mocked(getAllRecipeComponents).mockResolvedValue([makeComponent()]);
  vi.mocked(getAllItems).mockResolvedValue([
    makeItem(),
    makeItem({ item_id: 'item-produced', default_unit_cost: 0 }),
  ]);
  vi.mocked(getAllLots).mockResolvedValue([makeLot()]);
  vi.mocked(createLot).mockResolvedValue({
    lot_id: 'lot-produced-001',
    item_id: 'item-produced',
    location_id: 'loc-001',
    received_date: '2026-06-06',
    original_qty: 10,
    remaining_qty: 10,
    unit_cost: 0.6,
    source_ref: 'recipe-001',
  });
  vi.mocked(consumeFIFO).mockResolvedValue({
    lotConsumed: [{ lotId: 'lot-001', qty: 2, unitCost: 3.0 }],
  });
  vi.mocked(postTransaction).mockResolvedValue({
    txn_id: 'txn-001',
    timestamp: '2026-06-06T00:00:00Z',
    item_id: 'item-produced',
    location_id: 'loc-001',
    lot_id: 'lot-produced-001',
    qty_base: 10,
    txn_type: 'yield',
    ref_type: 'manual',
    ref_id: 'recipe-001',
    unit_cost: 0.6,
    user_id: 'user-1',
  });
});

// ─── getPlanningCost ──────────────────────────────────────────────────────────

describe('getPlanningCost — happy path', () => {
  it('computes totalCost = component.qty × item.default_unit_cost', async () => {
    // component.qty=2, default_unit_cost=3.0 → totalCost = 6.0
    const result = await getPlanningCost('recipe-001', adminSession);
    expect(result.totalCost).toBeCloseTo(6.0);
  });

  it('computes costPerServing = totalCost / recipe.serving_size', async () => {
    // totalCost=6.0, serving_size=5 → costPerServing = 1.2
    const result = await getPlanningCost('recipe-001', adminSession);
    expect(result.costPerServing).toBeCloseTo(1.2);
  });

  it('sums costs across multiple components', async () => {
    vi.mocked(getAllRecipeComponents).mockResolvedValue([
      makeComponent({ component_id: 'comp-001', component_item_id: 'item-001', qty: 2 }),
      makeComponent({ component_id: 'comp-002', component_item_id: 'item-002', qty: 4 }),
    ]);
    vi.mocked(getAllItems).mockResolvedValue([
      makeItem({ item_id: 'item-001', default_unit_cost: 3.0 }),
      makeItem({ item_id: 'item-002', default_unit_cost: 1.5 }),
    ]);

    const result = await getPlanningCost('recipe-001', adminSession);
    // (2 × 3.0) + (4 × 1.5) = 6 + 6 = 12
    expect(result.totalCost).toBeCloseTo(12.0);
    // 12 / 5 = 2.4
    expect(result.costPerServing).toBeCloseTo(2.4);
  });
});

describe('getPlanningCost — NotFoundError', () => {
  it('throws NotFoundError when recipe does not exist', async () => {
    vi.mocked(getAllRecipes).mockResolvedValue([]);
    await expect(
      getPlanningCost('nonexistent-recipe', adminSession)
    ).rejects.toThrow('Recipe not found');
  });
});

describe('getPlanningCost — session validation', () => {
  it('throws UnauthorizedError for session with empty userId', async () => {
    const badSession: Session = {
      userId: '',
      role: Role.director_admin,
      assignedLocationIds: 'all',
    };
    await expect(
      getPlanningCost('recipe-001', badSession)
    ).rejects.toThrow();
  });
});

// ─── getActualCost ────────────────────────────────────────────────────────────

describe('getActualCost — happy path (uses lot costs)', () => {
  it('uses FIFO weighted-average lot cost instead of default_unit_cost', async () => {
    // Single lot: remaining_qty=100, unit_cost=2.5 → effective cost = 2.5
    // component.qty=2 → component cost = 5.0
    // totalCost = 5.0, costPerServing = 5.0/5 = 1.0
    const result = await getActualCost('recipe-001', 'loc-001', adminSession);
    expect(result.totalCost).toBeCloseTo(5.0);
    expect(result.costPerServing).toBeCloseTo(1.0);
  });

  it('computes weighted average across multiple lots', async () => {
    vi.mocked(getAllLots).mockResolvedValue([
      makeLot({ lot_id: 'lot-A', remaining_qty: 40, unit_cost: 2.0, received_date: '2026-01-01' }),
      makeLot({ lot_id: 'lot-B', remaining_qty: 60, unit_cost: 3.0, received_date: '2026-02-01' }),
    ]);
    // Weighted avg = (40×2.0 + 60×3.0) / 100 = (80+180)/100 = 2.6
    // component.qty=2 → cost = 5.2
    // serving_size=5 → costPerServing = 1.04
    const result = await getActualCost('recipe-001', 'loc-001', adminSession);
    expect(result.totalCost).toBeCloseTo(5.2);
    expect(result.costPerServing).toBeCloseTo(1.04);
  });
});

describe('getActualCost — falls back to default_unit_cost when no lots', () => {
  it('uses item.default_unit_cost when no lots with remaining_qty > 0 exist', async () => {
    // All lots have remaining_qty=0 → fall back to default_unit_cost=3.0
    vi.mocked(getAllLots).mockResolvedValue([
      makeLot({ remaining_qty: 0 }),
    ]);
    // component.qty=2 × 3.0 = 6.0
    const result = await getActualCost('recipe-001', 'loc-001', adminSession);
    expect(result.totalCost).toBeCloseTo(6.0);
    expect(result.costPerServing).toBeCloseTo(1.2);
  });

  it('uses item.default_unit_cost when lots array is empty', async () => {
    vi.mocked(getAllLots).mockResolvedValue([]);
    const result = await getActualCost('recipe-001', 'loc-001', adminSession);
    expect(result.totalCost).toBeCloseTo(6.0);
  });
});

describe('getActualCost — NotFoundError', () => {
  it('throws NotFoundError when recipe does not exist', async () => {
    vi.mocked(getAllRecipes).mockResolvedValue([]);
    await expect(
      getActualCost('nonexistent-recipe', 'loc-001', adminSession)
    ).rejects.toThrow('Recipe not found');
  });
});

describe('getActualCost — access control', () => {
  it('throws ForbiddenError when session does not have location access', async () => {
    const restrictedSession: Session = {
      userId: 'user-x',
      role: Role.kitchen_manager,
      assignedLocationIds: ['loc-999'],
    };
    await expect(
      getActualCost('recipe-001', 'loc-001', restrictedSession)
    ).rejects.toThrow();
  });
});

// ─── runProduction ────────────────────────────────────────────────────────────

describe('runProduction — happy path', () => {
  it('calls consumeFIFO once per component with qty × multiplier', async () => {
    await runProduction(
      { recipeId: 'recipe-001', locationId: 'loc-001', multiplier: 2 },
      adminSession
    );

    // One component, multiplier=2 → qtyToConsume = component.qty(2) × multiplier(2) = 4
    expect(consumeFIFO).toHaveBeenCalledOnce();
    const consumeArg = vi.mocked(consumeFIFO).mock.calls[0][0];
    expect(consumeArg.itemId).toBe('item-001');
    expect(consumeArg.locationId).toBe('loc-001');
    expect(consumeArg.qty).toBe(4);           // 2 × 2
    expect(consumeArg.txnType).toBe('consume');
    expect(consumeArg.refType).toBe('manual');
    expect(consumeArg.refId).toBe('recipe-001');
  });

  it('creates a lot for the produced item', async () => {
    await runProduction(
      { recipeId: 'recipe-001', locationId: 'loc-001', multiplier: 1 },
      adminSession
    );

    expect(createLot).toHaveBeenCalledOnce();
    const lotArg = vi.mocked(createLot).mock.calls[0][0];
    expect(lotArg.item_id).toBe('item-produced');
    expect(lotArg.location_id).toBe('loc-001');
    // yield_qty=10 × multiplier=1 = 10
    expect(lotArg.original_qty).toBe(10);
    expect(lotArg.remaining_qty).toBe(10);
    expect(lotArg.source_ref).toBe('recipe-001');
    expect(lotArg.received_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('posts a yield transaction for the produced item', async () => {
    await runProduction(
      { recipeId: 'recipe-001', locationId: 'loc-001', multiplier: 1 },
      adminSession
    );

    expect(postTransaction).toHaveBeenCalledOnce();
    const txnArg = vi.mocked(postTransaction).mock.calls[0][0];
    expect(txnArg.txn_type).toBe('yield');
    expect(txnArg.item_id).toBe('item-produced');
    expect(txnArg.location_id).toBe('loc-001');
    expect(txnArg.ref_type).toBe('manual');
    expect(txnArg.ref_id).toBe('recipe-001');
    expect(txnArg.qty_base).toBe(10); // yield_qty=10 × multiplier=1
    expect(txnArg.lot_id).toBe('lot-produced-001');
  });

  it('computes totalCost from lotConsumed and returns correct result', async () => {
    // consumeFIFO returns: [{qty:2, unitCost:3.0}] → totalConsumedCost = 6.0
    // yield_qty=10 × 1 = 10 → costPerUnit = 6.0/10 = 0.6
    const result = await runProduction(
      { recipeId: 'recipe-001', locationId: 'loc-001', multiplier: 1 },
      adminSession
    );
    expect(result.totalCost).toBeCloseTo(6.0);
    expect(result.costPerUnit).toBeCloseTo(0.6);
    expect(result.producedLotId).toBe('lot-produced-001');
  });

  it('handles multiplier > 1 correctly', async () => {
    // multiplier=3, component.qty=2 → consume 6 per component
    // consumeFIFO mock returns qty:2 × unitCost:3.0 → need to simulate multiplied cost
    vi.mocked(consumeFIFO).mockResolvedValue({
      lotConsumed: [{ lotId: 'lot-001', qty: 6, unitCost: 3.0 }],
    });

    const result = await runProduction(
      { recipeId: 'recipe-001', locationId: 'loc-001', multiplier: 3 },
      adminSession
    );

    const consumeArg = vi.mocked(consumeFIFO).mock.calls[0][0];
    expect(consumeArg.qty).toBe(6); // 2 × 3

    // totalConsumedCost = 6 × 3.0 = 18, yieldQty = 10×3=30
    expect(result.totalCost).toBeCloseTo(18.0);
    expect(result.costPerUnit).toBeCloseTo(0.6);
  });

  it('passes note through to consumeFIFO', async () => {
    await runProduction(
      { recipeId: 'recipe-001', locationId: 'loc-001', multiplier: 1, note: 'Batch A' },
      adminSession
    );
    const consumeArg = vi.mocked(consumeFIFO).mock.calls[0][0];
    expect(consumeArg.note).toBe('Batch A');
  });

  it('passes session through to consumeFIFO', async () => {
    await runProduction(
      { recipeId: 'recipe-001', locationId: 'loc-001', multiplier: 1 },
      kitchenSession
    );
    const consumeArg = vi.mocked(consumeFIFO).mock.calls[0][0];
    expect(consumeArg.session.userId).toBe('user-2');
  });
});

describe('runProduction — multiplier validation', () => {
  it('throws ValidationError when multiplier is 0', async () => {
    await expect(
      runProduction({ recipeId: 'recipe-001', locationId: 'loc-001', multiplier: 0 }, adminSession)
    ).rejects.toThrow('multiplier must be a positive finite number');
    expect(consumeFIFO).not.toHaveBeenCalled();
  });

  it('throws ValidationError when multiplier is negative', async () => {
    await expect(
      runProduction({ recipeId: 'recipe-001', locationId: 'loc-001', multiplier: -1 }, adminSession)
    ).rejects.toThrow('multiplier must be a positive finite number');
    expect(consumeFIFO).not.toHaveBeenCalled();
  });

  it('throws ValidationError when multiplier is NaN', async () => {
    await expect(
      runProduction({ recipeId: 'recipe-001', locationId: 'loc-001', multiplier: NaN }, adminSession)
    ).rejects.toThrow('multiplier must be a positive finite number');
    expect(consumeFIFO).not.toHaveBeenCalled();
  });

  it('throws ValidationError when multiplier is Infinity', async () => {
    await expect(
      runProduction({ recipeId: 'recipe-001', locationId: 'loc-001', multiplier: Infinity }, adminSession)
    ).rejects.toThrow('multiplier must be a positive finite number');
    expect(consumeFIFO).not.toHaveBeenCalled();
  });
});

describe('runProduction — NotFoundError', () => {
  it('throws NotFoundError when recipe does not exist', async () => {
    vi.mocked(getAllRecipes).mockResolvedValue([]);
    await expect(
      runProduction({ recipeId: 'nonexistent', locationId: 'loc-001', multiplier: 1 }, adminSession)
    ).rejects.toThrow('Recipe not found');
    expect(consumeFIFO).not.toHaveBeenCalled();
  });
});

describe('runProduction — role access control', () => {
  it('throws ForbiddenError when role is vending_route (not allowed)', async () => {
    await expect(
      runProduction(
        { recipeId: 'recipe-001', locationId: 'loc-001', multiplier: 1 },
        vendingSession
      )
    ).rejects.toThrow();
    expect(consumeFIFO).not.toHaveBeenCalled();
  });

  it('succeeds when role is kitchen_manager with access to the location', async () => {
    await expect(
      runProduction(
        { recipeId: 'recipe-001', locationId: 'loc-001', multiplier: 1 },
        kitchenSession
      )
    ).resolves.toBeDefined();
  });
});
