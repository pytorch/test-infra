// Rotate a bounded batch without storing a cursor. Callers supply stable order.
export function getRotatingBatch<T>(
  items: T[],
  run: number,
  size: number
): T[] {
  if (items.length <= size) return items;
  const offset = (run * size) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)].slice(0, size);
}
