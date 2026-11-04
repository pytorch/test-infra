// The axis ticks for values up to `max`: from 0 in a round step, 1, 2 or 5
// times a power of ten, to the first tick at or past max, about four to six
// of them, so the bars scale to the last tick.
export function niceTicks(max: number, target = 5): number[] {
  if (!(max > 0)) return [0, 1];
  const rough = max / target;
  const power = Math.pow(10, Math.floor(Math.log10(rough)));
  const step =
    [1, 2, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? 10 * power;
  const ticks = [0];
  while (ticks[ticks.length - 1] < max) {
    ticks.push(Number((ticks[ticks.length - 1] + step).toPrecision(12)));
  }
  return ticks;
}
