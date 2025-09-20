import { LAST_N_DAYS } from "components/benchmark/common";
import { fetcher } from "lib/GeneralUtils";
import useSWR from "swr";

export type ArtifactFile = {
  key: string;
  url: string;
  date: string;
  modelName: string;
  deviceType: string;
  deviceName: string;
  fileName: string;
  commitHash: string;
  workflowId: string;
};

export type ArtifactResponse = {
  files: ArtifactFile[];
};

export type UseArtifactsOptions = {
  prefix?: string;
  lookbackDays?: number;
  modelName?: string;
  deviceType?: string;
  deviceName?: string;
};

const DEFAULT_OPTIONS: Required<Pick<UseArtifactsOptions, "lookbackDays">> = {
  lookbackDays: LAST_N_DAYS,
};

export const useArtifacts = (options: UseArtifactsOptions = {}) => {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };
  const params = new URLSearchParams();

  if (options.prefix) {
    params.set("prefix", options.prefix);
  }

  if (options.modelName) {
    params.set("modelName", options.modelName);
  }

  if (options.deviceType) {
    params.set("deviceType", options.deviceType);
  }

  if (options.deviceName) {
    params.set("deviceName", options.deviceName);
  }

  if (mergedOptions.lookbackDays) {
    params.set("lookbackDays", String(mergedOptions.lookbackDays));
  }

  const queryString = params.toString();
  const key = `/api/artifacts${queryString ? `?${queryString}` : ""}`;

  return useSWR<ArtifactResponse>(key, fetcher, {
    refreshInterval: 60 * 60 * 1000,
    dedupingInterval: 15 * 60 * 1000,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });
};
