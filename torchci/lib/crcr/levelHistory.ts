import { fetcherHandleError } from "lib/GeneralUtils";
import useSWR from "swr";

export interface LevelHistoryEvent {
  changed_at: string;
  previous_level: string;
  new_level: string;
}

const LEVEL_HISTORY_LIMIT = 100;

export function useLevelHistory(repoFullName: string) {
  const url = repoFullName
    ? `/api/clickhouse/crcr_level_history?parameters=${encodeURIComponent(
        JSON.stringify({ repo: repoFullName, limit: LEVEL_HISTORY_LIMIT })
      )}`
    : null;
  const { data, error } = useSWR<LevelHistoryEvent[]>(url, fetcherHandleError, {
    refreshInterval: 60_000,
  });
  return { events: data ?? [], error, loaded: data !== undefined || !!error };
}
