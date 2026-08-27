export const TEST_HISTORY_DAY_OPTIONS = [60, 30, 7, 1] as const;

export type TestHistoryDays = (typeof TEST_HISTORY_DAY_OPTIONS)[number];

export const DEFAULT_TEST_HISTORY_DAYS: TestHistoryDays = 7;

export function parseTestHistoryDays(value: unknown): TestHistoryDays | null {
  if (typeof value !== "string") return null;

  return (
    TEST_HISTORY_DAY_OPTIONS.find((days) => String(days) === value) ?? null
  );
}
