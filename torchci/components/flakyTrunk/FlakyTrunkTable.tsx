import { Chip, Stack } from "@mui/material";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import dayjs from "dayjs";
import { fetcher } from "lib/GeneralUtils";
import useSWR from "swr";
import { EntityKey, FLAKY_TRUNK_REPO, formatBucketRange } from "./common";
import { ENTITY_CONFIGS } from "./tableConfigs";

export interface BucketRange {
  start: dayjs.Dayjs;
  end: dayjs.Dayjs;
}

export default function FlakyTrunkTable({
  entity,
  startTime,
  stopTime,
  minRuns,
  selectedBucket,
  onClearFilter,
}: {
  entity: EntityKey;
  startTime: string;
  stopTime: string;
  minRuns: number;
  selectedBucket: BucketRange | null;
  onClearFilter: () => void;
}) {
  const config = ENTITY_CONFIGS[entity];

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
    refreshInterval: 5 * 60 * 1000,
  });

  const noun = config.label.toLowerCase();
  const title = selectedBucket ? (
    <Stack direction="row" alignItems="center" spacing={1}>
      <span>Flaky trunk {noun}</span>
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
    `Flaky trunk ${noun}`
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
