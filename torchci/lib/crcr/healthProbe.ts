// ci-infra uses the callback's six-hour default and invokes the sweeper every ten minutes.
export const CRCR_HEALTH_WINDOW_MINUTES = 12 * 60;
export const CRCR_HEALTH_WINDOW_LABEL = "12h";
export const CRCR_HEALTH_TIMEOUT_MINUTES = 6 * 60;
export const CRCR_HEALTH_SWEEPER_INTERVAL_MINUTES = 10;
export const CRCR_HEALTH_SWEEP_GRACE_MINUTES = 15;
export const CRCR_HEALTH_STALE_AFTER_MINUTES =
  CRCR_HEALTH_TIMEOUT_MINUTES +
  CRCR_HEALTH_SWEEPER_INTERVAL_MINUTES +
  CRCR_HEALTH_SWEEP_GRACE_MINUTES;

export interface CrcrHealthProbeRow {
  total: number;
  pass_rate: number | null;
  pending: number;
  overdue_in_progress: number;
}

export type CrcrHealthState = "healthy" | "awaiting_sweep" | "degraded";

export function summarizeCrcrHealth(rows: CrcrHealthProbeRow[]): {
  pending: number;
  overdue: number;
  passedCount: number;
  state: CrcrHealthState;
} {
  const pending = rows.reduce((sum, row) => sum + row.pending, 0);
  const overdue = rows.reduce(
    (sum, row) => sum + row.overdue_in_progress,
    0
  );
  const passedCount = rows.filter(
    (row) => row.total > 0 && row.pass_rate === 1.0 && row.pending === 0
  ).length;
  const hasFailures = rows.some(
    (row) => row.total > 0 && (row.pass_rate ?? 0) < 1.0
  );

  return {
    pending,
    overdue,
    passedCount,
    state:
      hasFailures || overdue > 0
        ? "degraded"
        : pending > 0
        ? "awaiting_sweep"
        : "healthy",
  };
}
