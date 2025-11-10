import { Typography } from "@mui/material";
import { Box } from "@mui/system";
import { BenchmarkLinkButton } from "components/benchmark_v3/components/common/BenchmarkLinkButton";
import { UIRenderConfig } from "components/benchmark_v3/configs/config_book_types";
import { BenchmarkCommitMeta } from "lib/benchmark/store/benchmark_regression_store";
import { stateToQuery } from "lib/helpers/urlQuery";
import { NextRouter, useRouter } from "next/router";

export function BenchmarkSingleViewNavigation({
  benchmarkId,
  lcommit,
  rcommit,
  config,
}: {
  benchmarkId: string;
  lcommit?: BenchmarkCommitMeta | null;
  rcommit?: BenchmarkCommitMeta | null;
  config: UIRenderConfig;
}) {
  const router = useRouter();

  const uiRenderConfig = config as UIRenderConfig;

  const title = uiRenderConfig.config?.title;

  if (!lcommit || !rcommit) {
    return <></>;
  }

  return (
    <Box>
      <Typography variant="h6">{title?.text}</Typography>
      {title?.description && (
        <Typography variant="body2">{title.description}</Typography>
      )}
      <BenchmarkLinkButton
        href={toSingleViewUrl(benchmarkId, lcommit, router)}
        variant="outlined"
        size="small"
      >
        {lcommit.workflow_id} ({lcommit.commit.slice(0, 7)})
      </BenchmarkLinkButton>{" "}
      <BenchmarkLinkButton
        href={toSingleViewUrl(benchmarkId, rcommit, router)}
        variant="outlined"
        size="small"
      >
        {rcommit.workflow_id} ({rcommit.commit.slice(0, 7)})
      </BenchmarkLinkButton>
    </Box>
  );
}

export function toSingleViewUrl(
  benchmarkId: string,
  commit: BenchmarkCommitMeta,
  router: NextRouter
) {
  const pathname = `/benchmark/v3/single/${benchmarkId}`;
  const lcommit: BenchmarkCommitMeta = commit;
  const rcommit: BenchmarkCommitMeta = {
    commit: "",
    date: "",
    workflow_id: "",
    branch: "",
  };
  const reformattedPrams = stateToQuery({
    lcommit,
    rcommit,
  });

  const nextDashboardMainQuery = {
    ...router.query, // keep existing params
    ...reformattedPrams,
    renderGroupId: "main",
  };
  const params = new URLSearchParams(
    Object.entries(nextDashboardMainQuery)
      .filter(([_, v]) => v != null && v !== "")
      .map(([k, v]) => [k, String(v)])
  );
  const url = `${pathname}?${params.toString()}`;
  return url;
}
