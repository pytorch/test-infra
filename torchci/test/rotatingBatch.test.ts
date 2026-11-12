import { getRotatingBatch } from "lib/rotatingBatch";

test("bounded rotation wraps and eventually includes every item", () => {
  const items = [1, 2, 3, 4, 5];
  expect(getRotatingBatch(items, 0, 2)).toEqual([1, 2]);
  expect(getRotatingBatch(items, 1, 2)).toEqual([3, 4]);
  expect(getRotatingBatch(items, 2, 2)).toEqual([5, 1]);
  expect(getRotatingBatch(items, 0, 10)).toEqual(items);
});
