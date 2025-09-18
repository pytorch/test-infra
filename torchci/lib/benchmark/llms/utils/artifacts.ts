import { fetcher } from "lib/GeneralUtils";
import useSWR from "swr";

export type ArtifactFile = {
  key: string;
  url: string;
  date: string;
  modelName: string;
  fileName: string;
};

export type ArtifactResponse = {
  files: ArtifactFile[];
};

export type UseArtifactsOptions = {
  prefix?: string;
  lookbackMonths?: number;
};

const DEFAULT_OPTIONS: Required<Pick<UseArtifactsOptions, "lookbackMonths">> = {
  lookbackMonths: 6,
};

export const useArtifacts = (options: UseArtifactsOptions = {}) => {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };
  const params = new URLSearchParams();

  if (options.prefix) {
    params.set("prefix", options.prefix);
  }

  if (mergedOptions.lookbackMonths) {
    params.set("lookbackMonths", String(mergedOptions.lookbackMonths));
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
