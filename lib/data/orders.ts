import 'server-only';

import { randomUUID } from 'node:crypto';
import { getRows, appendRow } from './sheets';
import { parseNum, parseEnum } from '../types';
import type { Order, OrderLine, OrderStatus } from '../types';

// Orders tab column order (0-based):
// order_id, vendor_id, destination_location_id, order_date, expected_date, status

// OrderLines tab column order (0-based):
// line_id, order_id, item_id, qty, unit, unit_cost

const ORDERS_TAB = 'Orders';
const LINES_TAB = 'OrderLines';

const ORDER_STATUSES: readonly OrderStatus[] = [
  'draft',
  'placed',
  'partially_received',
  'received',
  'closed',
];

// ─── Orders ───────────────────────────────────────────────────────────────────

function rowToOrder(row: string[]): Order {
  // status is load-bearing for the order state machine — throw on invalid values.
  const status = parseEnum(row[5], ORDER_STATUSES, 'order status');

  return {
    order_id: row[0] ?? '',
    vendor_id: row[1] ?? '',
    destination_location_id: row[2] ?? '',
    order_date: row[3] ?? '',
    expected_date: (row[4] ?? '') !== '' ? row[4] : undefined,
    status,
  };
}

function orderToRow(order: Order): unknown[] {
  return [
    order.order_id,
    order.vendor_id,
    order.destination_location_id,
    order.order_date,
    order.expected_date ?? '',
    order.status,
  ];
}

export { rowToOrder, orderToRow };

export async function getAllOrders(): Promise<Order[]> {
  const rows = await getRows(ORDERS_TAB);
  return rows.filter((r) => r[0] !== '').map(rowToOrder);
}

export async function createOrder(
  data: Omit<Order, 'order_id'>
): Promise<Order> {
  const order: Order = { order_id: randomUUID(), ...data };
  await appendRow(ORDERS_TAB, orderToRow(order));
  return order;
}

// ─── OrderLines ───────────────────────────────────────────────────────────────

function rowToOrderLine(row: string[]): OrderLine {
  return {
    line_id: row[0] ?? '',
    order_id: row[1] ?? '',
    item_id: row[2] ?? '',
    qty: parseNum(row[3]),
    unit: row[4] ?? '',
    unit_cost: parseNum(row[5]),
  };
}

function orderLineToRow(line: OrderLine): unknown[] {
  return [
    line.line_id,
    line.order_id,
    line.item_id,
    line.qty,
    line.unit,
    line.unit_cost,
  ];
}

export { rowToOrderLine, orderLineToRow };

export async function getAllOrderLines(): Promise<OrderLine[]> {
  const rows = await getRows(LINES_TAB);
  return rows.filter((r) => r[0] !== '').map(rowToOrderLine);
}

export async function createOrderLine(
  data: Omit<OrderLine, 'line_id'>
): Promise<OrderLine> {
  const line: OrderLine = { line_id: randomUUID(), ...data };
  await appendRow(LINES_TAB, orderLineToRow(line));
  return line;
}
