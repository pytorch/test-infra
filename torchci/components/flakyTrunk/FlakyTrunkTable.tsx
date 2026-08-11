import { Chip, Stack } from "@mui/material";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import { fetcher } from "lib/GeneralUtils";
import useSWR from "swr";
import { BucketRange, FLAKY_TRUNK_REPO, formatBucketRange } from "./common";
import { FlakyTrunkTableConfig } from "./tableConfigs";

export default function FlakyTrunkTable({
  config,
  startTime,
  stopTime,
  minRuns,
  selectedBucket,
  onClearFilter,
  autoRefresh,
}: {
  config: FlakyTrunkTableConfig;
  startTime: string;
  stopTime: string;
  minRuns: number;
  selectedBucket: BucketRange | null;
  onClearFilter: () => void;
  autoRefresh: boolean;
}) {
  const url = `/api/clickhouse/${
    config.queryName
  }?parameters=${encodeURIComponent(
    JSON.stringify({
      startTime,
      stopTime,
      repo: FLAKY_TRUNK_REPO,
      minRuns,
    })
  )}`;

  const { data } = useSWR(url, fetcher, {
    refreshInterval: autoRefresh ? 5 * 60 * 1000 : 0,
  });

  const title = selectedBucket ? (
    <Stack direction="row" alignItems="center" spacing={1}>
      <span>{config.heading}</span>
      <Chip
        label={`Filtered to ${formatBucketRange(
          selectedBucket.start,
          selectedBucket.end
        )}`}
        onDelete={onClearFilter}
        size="small"
        color="primary"
        variant="outlined"
      />
    </Stack>
  ) : (
    config.heading
  );

  return (
    <TablePanelWithData
      title={title}
      data={data}
      columns={config.columns}
      showFooter={true}
      dataGridProps={{
        getRowId: config.getRowId,
        initialState: {
          sorting: {
            sortModel: [{ field: config.defaultSortField, sort: "desc" }],
          },
        },
      }}
    />
  );
}
