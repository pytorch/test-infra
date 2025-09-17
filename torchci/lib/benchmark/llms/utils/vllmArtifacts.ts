import useSWR from "swr";
import { fetcher } from "lib/GeneralUtils";

export type VllmArtifactFile = {
  key: string;
  fileName: string;
  url: string;
};

export type VllmArtifactResponse = {
  files: VllmArtifactFile[];
};

export const useVllmArtifacts = () =>
  useSWR<VllmArtifactResponse>("/api/vllm/artifacts", fetcher, {
    refreshInterval: 60 * 60 * 1000,
  });
