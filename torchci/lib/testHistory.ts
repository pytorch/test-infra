const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const TEST_HISTORY_RANGE_OPTIONS = [
  { value: "60d", label: "60 days", durationMs: 60 * DAY_MS },
  { value: "30d", label: "30 days", durationMs: 30 * DAY_MS },
  { value: "7d", label: "7 days", durationMs: 7 * DAY_MS },
  { value: "1d", label: "1 day", durationMs: DAY_MS },
  { value: "1h", label: "1 hour", durationMs: HOUR_MS },
] as const;

export type TestHistoryRange =
  (typeof TEST_HISTORY_RANGE_OPTIONS)[number]["value"];

export const DEFAULT_TEST_HISTORY_RANGE: TestHistoryRange = "7d";

export function parseTestHistoryRange(value: unknown): TestHistoryRange | null {
  if (typeof value !== "string") return null;

  return (
    TEST_HISTORY_RANGE_OPTIONS.find((option) => option.value === value)
      ?.value ?? null
  );
}

export function getTestHistoryRange(range: TestHistoryRange) {
  return TEST_HISTORY_RANGE_OPTIONS.find((option) => option.value === range)!;
}
