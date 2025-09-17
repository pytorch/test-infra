import { fetcher } from "lib/GeneralUtils";
import useSWR from "swr";

export type VllmArtifactFile = {
  key: string;
  url: string;
  date: string;
  modelName: string;
  fileName: string;
};

export type VllmArtifactResponse = {
  files: VllmArtifactFile[];
};

export const useVllmArtifacts = () =>
  useSWR<VllmArtifactResponse>("/api/vllm/artifacts", fetcher, {
    refreshInterval: 60 * 60 * 1000,
    dedupingInterval: 15 * 60 * 1000,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });
