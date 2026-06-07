import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Receipt, ReceiptLine } from '../../../lib/types';
import {
  IdempotencyConflictError,
  RetryableMutationError,
} from '../../../lib/services/errors';

const sheetsMock = vi.hoisted(() => ({
  getRows: vi.fn(),
  appendRow: vi.fn(),
  updateRow: vi.fn(),
}));

vi.mock('../../../lib/data/sheets', () => sheetsMock);

import {
  ensureReceipt,
  ensureReceiptLine,
  getReceiptLines,
  receiptToRow,
  receiptLineToRow,
} from '../../../lib/data/receipts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    receipt_id: 'rcpt:v1:abc',
    order_id: 'order-1',
    source: 'vendor-1',
    location_id: 'loc-1',
    receipt_date: '2026-06-06',
    received_by: 'user-1',
    ...overrides,
  };
}

function makeReceiptLine(overrides: Partial<ReceiptLine> = {}): ReceiptLine {
  return {
    line_id: 'rline:v1:abc',
    receipt_id: 'rcpt:v1:abc',
    item_id: 'item-1',
    qty_received: 10,
    unit: 'each',
    unit_cost: 2.5,
    expiration_date: '2026-12-31',
    ...overrides,
  };
}

function rowsForReceipts(...receipts: Receipt[]): string[][] {
  return receipts.map((r) => receiptToRow(r).map(String));
}

function rowsForLines(...lines: ReceiptLine[]): string[][] {
  return lines.map((l) => receiptLineToRow(l).map(String));
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── ensureReceipt ────────────────────────────────────────────────────────────

describe('ensureReceipt', () => {
  it('appends and returns a new receipt when receipt_id is absent', async () => {
    const expected = makeReceipt();

    sheetsMock.getRows
      .mockResolvedValueOnce([]) // receipts: absent
      .mockResolvedValueOnce(rowsForReceipts(expected)); // re-read: visible

    const result = await ensureReceipt(expected);

    expect(sheetsMock.appendRow).toHaveBeenCalledOnce();
    expect(sheetsMock.appendRow).toHaveBeenCalledWith(
      'Receipts',
      receiptToRow(expected)
    );
    expect(result.value.receipt_id).toBe('rcpt:v1:abc');
    expect(result.outcome).toBe('created');
  });

  it('returns existing receipt without appending on retry with identical payload', async () => {
    const existing = makeReceipt({
      receipt_date: '2026-01-01',
      received_by: 'original-user',
    });
    // Caller retries with slightly different receipt_date — original is preserved.
    const expected = makeReceipt({
      receipt_date: '2026-06-06',
      received_by: 'retry-user',
    });

    sheetsMock.getRows.mockResolvedValue(rowsForReceipts(existing));

    const result = await ensureReceipt(expected);

    expect(sheetsMock.appendRow).not.toHaveBeenCalled();
    expect(result.value.receipt_date).toBe('2026-01-01'); // original preserved
    expect(result.value.received_by).toBe('original-user'); // original preserved
    expect(result.outcome).toBe('existing');
  });

  it('throws IdempotencyConflictError when same receipt_id but source_location_id (source) conflicts', async () => {
    sheetsMock.getRows.mockResolvedValue(rowsForReceipts(makeReceipt()));
    const conflicting = makeReceipt({ source: 'DIFFERENT-SOURCE' });

    await expect(ensureReceipt(conflicting)).rejects.toBeInstanceOf(
      IdempotencyConflictError
    );
    expect(sheetsMock.appendRow).not.toHaveBeenCalled();
  });

  it('throws IdempotencyConflictError when same receipt_id but location_id conflicts', async () => {
    sheetsMock.getRows.mockResolvedValue(rowsForReceipts(makeReceipt()));
    const conflicting = makeReceipt({ location_id: 'loc-CONFLICT' });

    await expect(ensureReceipt(conflicting)).rejects.toBeInstanceOf(
      IdempotencyConflictError
    );
    expect(sheetsMock.appendRow).not.toHaveBeenCalled();
  });

  it('throws IdempotencyConflictError when same receipt_id but order_id conflicts', async () => {
    sheetsMock.getRows.mockResolvedValue(rowsForReceipts(makeReceipt()));
    const conflicting = makeReceipt({ order_id: 'order-CONFLICT' });

    await expect(ensureReceipt(conflicting)).rejects.toBeInstanceOf(
      IdempotencyConflictError
    );
    expect(sheetsMock.appendRow).not.toHaveBeenCalled();
  });

  it('throws RetryableMutationError when appended receipt is not visible on re-read', async () => {
    const expected = makeReceipt();

    sheetsMock.getRows
      .mockResolvedValueOnce([]) // first read: absent
      .mockResolvedValueOnce([]); // second read: still not visible

    await expect(ensureReceipt(expected)).rejects.toBeInstanceOf(
      RetryableMutationError
    );
    expect(sheetsMock.appendRow).toHaveBeenCalledOnce();
  });
});

// ─── ensureReceiptLine ────────────────────────────────────────────────────────

describe('ensureReceiptLine', () => {
  it('appends and returns a new receipt line when line_id is absent', async () => {
    const expected = makeReceiptLine();

    sheetsMock.getRows
      .mockResolvedValueOnce([]) // lines: absent
      .mockResolvedValueOnce(rowsForLines(expected)); // re-read: visible

    const result = await ensureReceiptLine(expected);

    expect(sheetsMock.appendRow).toHaveBeenCalledOnce();
    expect(sheetsMock.appendRow).toHaveBeenCalledWith(
      'ReceiptLines',
      receiptLineToRow(expected)
    );
    expect(result.value.line_id).toBe('rline:v1:abc');
    expect(result.outcome).toBe('created');
  });

  it('returns existing line without appending on retry with identical payload', async () => {
    const existing = makeReceiptLine();

    sheetsMock.getRows.mockResolvedValue(rowsForLines(existing));

    const result = await ensureReceiptLine(existing);

    expect(sheetsMock.appendRow).not.toHaveBeenCalled();
    expect(result.value.line_id).toBe('rline:v1:abc');
    expect(result.outcome).toBe('existing');
  });

  it('throws IdempotencyConflictError when same line_id but qty_received conflicts', async () => {
    sheetsMock.getRows.mockResolvedValue(rowsForLines(makeReceiptLine()));
    const conflicting = makeReceiptLine({ qty_received: 999 });

    await expect(ensureReceiptLine(conflicting)).rejects.toBeInstanceOf(
      IdempotencyConflictError
    );
    expect(sheetsMock.appendRow).not.toHaveBeenCalled();
  });

  it('throws IdempotencyConflictError when same line_id but unit conflicts', async () => {
    sheetsMock.getRows.mockResolvedValue(rowsForLines(makeReceiptLine()));
    const conflicting = makeReceiptLine({ unit: 'lb' });

    await expect(ensureReceiptLine(conflicting)).rejects.toBeInstanceOf(
      IdempotencyConflictError
    );
    expect(sheetsMock.appendRow).not.toHaveBeenCalled();
  });

  it('throws IdempotencyConflictError when same line_id but unit_cost conflicts', async () => {
    sheetsMock.getRows.mockResolvedValue(rowsForLines(makeReceiptLine()));
    const conflicting = makeReceiptLine({ unit_cost: 99.99 });

    await expect(ensureReceiptLine(conflicting)).rejects.toBeInstanceOf(
      IdempotencyConflictError
    );
    expect(sheetsMock.appendRow).not.toHaveBeenCalled();
  });

  it('throws IdempotencyConflictError when same line_id but item_id conflicts', async () => {
    sheetsMock.getRows.mockResolvedValue(rowsForLines(makeReceiptLine()));
    const conflicting = makeReceiptLine({ item_id: 'item-CONFLICT' });

    await expect(ensureReceiptLine(conflicting)).rejects.toBeInstanceOf(
      IdempotencyConflictError
    );
    expect(sheetsMock.appendRow).not.toHaveBeenCalled();
  });

  it('throws IdempotencyConflictError when same line_id but expiration_date conflicts', async () => {
    sheetsMock.getRows.mockResolvedValue(rowsForLines(makeReceiptLine()));
    const conflicting = makeReceiptLine({ expiration_date: '2099-01-01' });

    await expect(ensureReceiptLine(conflicting)).rejects.toBeInstanceOf(
      IdempotencyConflictError
    );
    expect(sheetsMock.appendRow).not.toHaveBeenCalled();
  });

  it('throws RetryableMutationError when appended line is not visible on re-read', async () => {
    const expected = makeReceiptLine();

    sheetsMock.getRows
      .mockResolvedValueOnce([]) // first read: absent
      .mockResolvedValueOnce([]); // second read: still not visible

    await expect(ensureReceiptLine(expected)).rejects.toBeInstanceOf(
      RetryableMutationError
    );
    expect(sheetsMock.appendRow).toHaveBeenCalledOnce();
  });
});

// ─── getReceiptLines ──────────────────────────────────────────────────────────

describe('getReceiptLines', () => {
  it('returns only lines belonging to the specified receiptId', async () => {
    sheetsMock.getRows.mockResolvedValue(
      rowsForLines(
        makeReceiptLine({ line_id: 'line-a', receipt_id: 'rcpt:v1:abc' }),
        makeReceiptLine({ line_id: 'line-b', receipt_id: 'rcpt:v1:OTHER' }),
        makeReceiptLine({ line_id: 'line-c', receipt_id: 'rcpt:v1:abc' })
      )
    );

    const lines = await getReceiptLines('rcpt:v1:abc');

    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.line_id).sort()).toEqual(['line-a', 'line-c']);
  });

  it('returns an empty array when no lines match the receiptId', async () => {
    sheetsMock.getRows.mockResolvedValue([]);

    const lines = await getReceiptLines('rcpt:v1:abc');

    expect(lines).toHaveLength(0);
  });
});
