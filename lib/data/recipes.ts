import 'server-only';

import { randomUUID } from 'node:crypto';
import { getRows, appendRow } from './sheets';
import { parseNum } from '../types';
import type { Recipe } from '../types';

// Tab: Recipes
// Column order (0-based):
// recipe_id, produced_item_id, yield_qty, yield_unit, serving_size

const TAB = 'Recipes';

function rowToRecipe(row: string[]): Recipe {
  return {
    recipe_id: row[0] ?? '',
    produced_item_id: row[1] ?? '',
    yield_qty: parseNum(row[2]),
    yield_unit: row[3] ?? '',
    serving_size: parseNum(row[4]),
  };
}

function recipeToRow(recipe: Recipe): unknown[] {
  return [
    recipe.recipe_id,
    recipe.produced_item_id,
    recipe.yield_qty,
    recipe.yield_unit,
    recipe.serving_size,
  ];
}

export { rowToRecipe, recipeToRow };

export async function getAllRecipes(): Promise<Recipe[]> {
  const rows = await getRows(TAB);
  return rows.filter((r) => r[0] !== '').map(rowToRecipe);
}

export async function createRecipe(
  data: Omit<Recipe, 'recipe_id'>
): Promise<Recipe> {
  const recipe: Recipe = { recipe_id: randomUUID(), ...data };
  await appendRow(TAB, recipeToRow(recipe));
  return recipe;
}
