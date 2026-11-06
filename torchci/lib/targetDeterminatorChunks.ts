// Sections whose query reads a bounded window fetch longer ones in chunks: one
// SWR entry per grid cell, merged into one answer.

import {
  CLAMP_DAYS,
  type CountedRange,
  countedRange,
  DAY_MS,
  dayStart,
  JOB_NAMES_VALID_FROM,
  parseUtc,
  rangeText,
  readsAtMost,
  sectionLimits,
  TD_QUERIES,
  type TdParams,
  useTdQuery,
  utcText,
} from "lib/targetDeterminator";
import { num, type TdQueryState } from "lib/targetDeterminatorRows";

export interface Chunk extends TdParams {
  label: string;
}

// One query slot per chunk. Nine 49-day cells hold any 365-day range.
export const MAX_CHUNKS = 9;

// Each chunked section's query, its cells (as wide as the query's SQL clamp),
// the counts it sums over its chunks' total rows and the row grains it keeps.
export const CHUNKED_SECTIONS = {
  breakages: {
    query: TD_QUERIES.breakages,
    cellDays: CLAMP_DAYS.breakages,
    counts: ["events", "false_green", "signal_on_pr", "passed_on_pr"],
    keep: ["event"],
  },
  ranks: {
    query: TD_QUERIES.ranks,
    cellDays: CLAMP_DAYS.ranks,
    counts: ["landings", "inside_cut"],
    keep: ["landing"],
  },
  stability: {
    query: TD_QUERIES.churn,
    cellDays: CLAMP_DAYS.stability,
    counts: ["pairs", "identical_pairs"],
    keep: ["day", "week", "hist"],
  },
} as const;

export type ChunkedSection = keyof typeof CHUNKED_SECTIONS;

// The grid is fixed at JOB_NAMES_VALID_FROM, a Monday, so a chunk whose data
// no longer changes keeps its SWR key and its answer, and cells of whole weeks
// split no ISO week. Each chunk is a grid cell cut to the range; cells that
// start after now hold no data and are not fetched. Beyond MAX_CHUNKS cells the
// oldest are dropped and the range narrows to the cells kept.
export function rangeChunks(
  range: CountedRange,
  cellDays: number,
  now: number = Date.now()
): { chunks: Chunk[]; range: CountedRange } {
  if (range.params === undefined) {
    return { chunks: [], range };
  }
  const anchor = dayStart(JOB_NAMES_VALID_FROM);
  const cell = cellDays * DAY_MS;
  const stopTime = range.params.stopTime;
  const stop = parseUtc(stopTime);
  const last = Math.min(stop, now);
  const cells: [number, number][] = [];
  for (
    let k = Math.floor((range.start - anchor) / cell);
    anchor + k * cell < last;
    k++
  ) {
    cells.push([
      Math.max(range.start, anchor + k * cell),
      Math.min(stop, anchor + (k + 1) * cell),
    ]);
  }
  const kept = cells.slice(-MAX_CHUNKS);
  const narrowed =
    kept.length === cells.length
      ? range
      : {
          ...range,
          params: { startTime: utcText(kept[0][0]), stopTime },
          start: kept[0][0],
          note: readsAtMost(MAX_CHUNKS * cellDays),
        };
  return {
    chunks: kept.map(([from, to]) => ({
      startTime: utcText(from),
      stopTime: utcText(to),
      label: rangeText({ start: from, end: to }),
    })),
    range: narrowed,
  };
}

// The part of the picked window a section counts, cut into its chunks.
export function sectionChunks<S extends ChunkedSection>(
  section: S,
  params: TdParams,
  now: number = Date.now()
) {
  const spec = CHUNKED_SECTIONS[section];
  return {
    spec,
    ...rangeChunks(
      countedRange(params, sectionLimits(now)[section], now),
      spec.cellDays,
      now
    ),
  };
}

// A slot waiting for its turn: the merge waits for it as for one in flight.
export const HELD_SLOT: TdQueryState<never> = { loading: true, rows: [] };

// Slots start in order with at most two in flight: slot i starts once every
// slot before i - 1 has answered, and no slot starts after a failure.
export function slotStarts(earlier: TdQueryState<unknown>[]): boolean {
  return (
    earlier.slice(0, -1).every((state) => !state.loading) &&
    earlier.every((state) => state.error === undefined)
  );
}

function useSlot<T>(
  queryName: string,
  chunks: Chunk[],
  earlier: TdQueryState<T>[],
  extra: Record<string, unknown>
): TdQueryState<T> {
  const chunk = chunks[earlier.length];
  const held = chunk !== undefined && !slotStarts(earlier);
  const state = useTdQuery<T>(queryName, held ? undefined : chunk, extra);
  return held ? HELD_SLOT : state;
}

// Hooks cannot run in a loop, hence one call per MAX_CHUNKS slot. Each slot
// reads the states of the slots before it, so it is gated in the same render.
export function useChunkedTdQuery<T>(
  queryName: string,
  chunks: Chunk[],
  extra: Record<string, unknown> = {}
): TdQueryState<T>[] {
  const states: TdQueryState<T>[] = [];
  states.push(useSlot(queryName, chunks, states, extra));
  states.push(useSlot(queryName, chunks, states, extra));
  states.push(useSlot(queryName, chunks, states, extra));
  states.push(useSlot(queryName, chunks, states, extra));
  states.push(useSlot(queryName, chunks, states, extra));
  states.push(useSlot(queryName, chunks, states, extra));
  states.push(useSlot(queryName, chunks, states, extra));
  states.push(useSlot(queryName, chunks, states, extra));
  states.push(useSlot(queryName, chunks, states, extra));
  return states;
}

export interface ChunkedState<T, K extends string> extends TdQueryState<T> {
  total?: Record<K, number>;
  tileError?: string;
}

// One failed or malformed chunk fails the whole section: a sum over the chunks
// that answered would pass for the window's total. A failed chunk keeps its SWR
// key and is not retried, so only a reload fetches it again. The total holds
// only the counts the page reads.
export function mergeChunks<
  T extends { grain: string },
  K extends keyof T & string
>(
  queryName: string,
  chunks: Chunk[],
  states: TdQueryState<T>[],
  { counts, keep }: { counts: readonly K[]; keep: readonly string[] }
): ChunkedState<T, K> {
  const failed = (error: string) => ({
    loading: false,
    error,
    tileError: error,
    rows: [],
  });
  if (states.length < chunks.length) {
    return failed(`${queryName}: more chunks than query slots`);
  }
  const answered = chunks.map((chunk, i) => ({ chunk, state: states[i] }));
  const error = answered.find(({ state }) => state.error !== undefined);
  if (error !== undefined) {
    return failed(
      `${error.state.error} (${error.chunk.label}). Reload the page to retry.`
    );
  }
  if (answered.some(({ state }) => state.loading)) {
    return { loading: true, rows: [] };
  }
  let total: Record<K, number> | undefined;
  for (const { chunk, state } of answered) {
    const found = state.rows.filter((row) => row.grain === "total");
    if (found.length !== 1) {
      return failed(
        `${queryName} (${chunk.label}): ${found.length} total rows, expected 1`
      );
    }
    const sum = {} as Record<K, number>;
    for (const key of counts) {
      const value = num(found[0][key]);
      if (value === null) {
        return failed(`${queryName} (${chunk.label}): ${key} is not a number`);
      }
      sum[key] = (total?.[key] ?? 0) + value;
    }
    total = sum;
  }
  return {
    loading: false,
    rows: answered.flatMap(({ state }) =>
      state.rows.filter((row) => keep.includes(row.grain))
    ),
    total,
  };
}
