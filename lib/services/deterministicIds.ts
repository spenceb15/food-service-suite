import { createHash } from 'node:crypto';
import { ValidationError } from './errors';

export const LEDGER_DECIMALS = 6;

const FIXED_DECIMAL_UPPER_BOUND = 1e21;
const DETERMINISTIC_ID_PREFIX_PATTERN =
  /^[a-z][a-z0-9]*(?::[a-z0-9]+)*$/;

export function normalizeLedgerNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new ValidationError('number must be finite');
  }

  if (Math.abs(value) >= FIXED_DECIMAL_UPPER_BOUND) {
    throw new ValidationError('number exceeds fixed decimal range');
  }

  const normalized = value.toFixed(LEDGER_DECIMALS);
  return Number(normalized) === 0
    ? (0).toFixed(LEDGER_DECIMALS)
    : normalized;
}

export function normalizePositiveLedgerNumber(value: number): string {
  const normalized = normalizeLedgerNumber(value);

  if (Number(normalized) <= 0) {
    throw new ValidationError(
      'number must remain positive after normalization'
    );
  }

  return normalized;
}

export function deterministicId(
  prefix: string,
  components: string[]
): string {
  if (!DETERMINISTIC_ID_PREFIX_PATTERN.test(prefix)) {
    throw new ValidationError('prefix must use canonical lowercase ASCII');
  }

  if (
    components.length === 0 ||
    components.some((component) => !component.trim())
  ) {
    throw new ValidationError('components must be non-empty');
  }

  const trimmedComponents = components.map((component) => component.trim());
  const suffix = createHash('sha256')
    .update(JSON.stringify(trimmedComponents))
    .digest('hex')
    .slice(0, 32);

  return `${prefix}:${suffix}`;
}
