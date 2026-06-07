import 'server-only';

import { randomUUID } from 'node:crypto';
import { getRows, appendRow } from './sheets';
import { parseNum } from '../types';
import type { RecipeComponent } from '../types';

// Tab: RecipeComponents
// Column order (0-based):
// component_id, recipe_id, component_item_id, qty, unit

const TAB = 'RecipeComponents';

function rowToRecipeComponent(row: string[]): RecipeComponent {
  return {
    component_id: row[0] ?? '',
    recipe_id: row[1] ?? '',
    component_item_id: row[2] ?? '',
    qty: parseNum(row[3]),
    unit: row[4] ?? '',
  };
}

function recipeComponentToRow(rc: RecipeComponent): unknown[] {
  return [
    rc.component_id,
    rc.recipe_id,
    rc.component_item_id,
    rc.qty,
    rc.unit,
  ];
}

export { rowToRecipeComponent, recipeComponentToRow };

export async function getAllRecipeComponents(): Promise<RecipeComponent[]> {
  const rows = await getRows(TAB);
  return rows.filter((r) => r[0] !== '').map(rowToRecipeComponent);
}

export async function createRecipeComponent(
  data: Omit<RecipeComponent, 'component_id'>
): Promise<RecipeComponent> {
  const rc: RecipeComponent = { component_id: randomUUID(), ...data };
  await appendRow(TAB, recipeComponentToRow(rc));
  return rc;
}
