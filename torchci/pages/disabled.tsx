import { Grid2, Stack, Typography } from "@mui/material";
import { GridCellParams, GridRenderCellParams } from "@mui/x-data-grid";
import CopyLink from "components/common/CopyLink";
import ValuePicker from "components/common/ValuePicker";
import styles from "components/metrics.module.css";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import TimeSeriesPanel, {
  Granularity,
} from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { encodeParams, useClickHouseAPI } from "lib/GeneralUtils";
import _ from "lodash";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { TimeRangePicker } from "./metrics";

const GRAPH_ROW_HEIGHT = 240;
const DEFAULT_ISSUE_STATE = "open";
const ISSUE_STATES = [DEFAULT_ISSUE_STATE, "closed"];
const DEFAULT_PLATFORM = "All platforms";
// Maybe figure out a better way to not hardcode this list here
// https://github.com/pytorch/pytorch/blob/main/torch/testing/_internal/common_utils.py#L2266
const PLATFORMS = [
  DEFAULT_PLATFORM,
  "asan",
  "dynamo",
  "inductor",
  "linux",
  "mac",
  "rocm",
  "slow",
  "win",
  "xpu",
];
const DEFAULT_LABEL = "All labels";
const SKIPPED_LABEL = "skipped";
const TRIAGED_LABEL = "triaged";
const HIGH_PRIORITY_LABEL = "high priority";
const ACCEPTED_LABELS_REGEX = new RegExp(
  "^((module:s*.*)|(oncall:s*.*)|skipped)$"
);
const DEFAULT_TRIAGED_STATE = "both";
const TRIAGED_STATES = [DEFAULT_TRIAGED_STATE, "yes", "no"];
const DISABLED_TEST_TITLE_REGEX = new RegExp(
  "^(?<testCase>.*)s*\\(__main__.(?<testClass>.*)\\)$"
);
const TEST_PATH_REGEX = new RegExp("Test file path: `(?<testPath>[^\\s]*)`");

function getLabels(data: any) {
  const acceptedLabels: string[] = [];
  data.forEach((r: any) => {
    if (r.label.match(ACCEPTED_LABELS_REGEX)) {
      acceptedLabels.push(r.label !== SKIPPED_LABEL ? r.label : DEFAULT_LABEL);
    }
  });

  return _.sortBy(_.uniq(acceptedLabels));
}

function generateDisabledTestsTable(data: any) {
  const disabledTests: any = [];
  data.forEach((r: any) => {
    const title = r.name;
    const titleMatch = title.match(DISABLED_TEST_TITLE_REGEX);
    const testCase = titleMatch ? titleMatch.groups.testCase : title;
    const testClass = titleMatch ? titleMatch.groups.testClass : "";

    const bodyMatch = r.body.match(TEST_PATH_REGEX);
    const testPath = bodyMatch ? bodyMatch.groups.testPath : "";

    disabledTests.push({
      metadata: {
        number: r.number,
        url: r.html_url,
        triaged: r.labels.some((label: string) => label === TRIAGED_LABEL),
        hiprio: r.labels.some((label: string) => label === HIGH_PRIORITY_LABEL),
      },
      testCase: testCase,
      testClass: testClass,
      testPath: testPath,
      assignee: r.assignee,
      timestamp: r.updated_at,
    });
  });
  return _.sortBy(disabledTests, (r) => !r.metadata.hiprio);
}

function GraphPanel({ queryParams }: { queryParams: { [key: string]: any } }) {
  return (
    <Grid2 size={{ xs: 12, lg: 6 }} height={GRAPH_ROW_HEIGHT}>
      <TimeSeriesPanel
        title={"Number of open disabled tests"}
        queryName={"disabled_test_historical"}
        queryParams={queryParams}
        granularity={"day"}
        timeFieldName={"day"}
        yAxisFieldName={"count"}
        yAxisRenderer={(duration) => duration}
        fillMissingData={false}
      />
    </Grid2>
  );
}

function DisabledTestsPanel({
  queryParams,
}: {
  queryParams: { [key: string]: any };
}) {
  const queryName = "disabled_tests";

  let { data, error, isLoading } = useClickHouseAPI(
    queryName,
    queryParams,
    true,
    {
      refreshInterval: 60 * 60 * 1000, // refresh every hour
    }
  );

  if (error) {
    return (
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"1rem"} fontStyle={"italic"}>
          Failed to load disabled tests
        </Typography>
      </Stack>
    );
  }

  if (isLoading) {
    return (
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"1rem"} fontStyle={"italic"}>
          Loading disabled tests...
        </Typography>
      </Stack>
    );
  }

  const disabledTests = generateDisabledTestsTable(data);
  return (
    <Grid2 container spacing={2} style={{ height: "100%" }}>
      <Grid2 size={{ xs: 12, lg: 12 }}>
        <TablePanelWithData
          title={`Disabled tests (${disabledTests.length})`}
          data={disabledTests}
          columns={[
            {
              field: "metadata",
              headerName: "GitHub Issue (⚠ ~ high priority)",
              flex: 1,
              cellClassName: (params: GridCellParams<any, any>) => {
                return params.value.hiprio ? styles.warning : "";
              },
              renderCell: (params: GridRenderCellParams<any>) => {
                const number = params.value.number;
                const url = params.value.url;
                const hiprio = params.value.hiprio ? "⚠" : "";

                return (
                  <>
                    <a href={url}>
                      <b>
                        {hiprio} #{number}
                      </b>
                    </a>
                  </>
                );
              },
            },
            {
              field: "testCase",
              headerName: "Testcase",
              flex: 1,
              renderCell: (params: GridRenderCellParams<any>) => {
                return params.value;
              },
            },
            {
              field: "testClass",
              headerName: "Test Class",
              flex: 1,
              renderCell: (params: GridRenderCellParams<any>) => {
                return params.value;
              },
            },
            {
              field: "testPath",
              headerName: "Test File",
              flex: 1,
              renderCell: (params: GridRenderCellParams<any>) => {
                return (
                  <>
                    <a
                      href={`https://github.com/pytorch/pytorch/blob/main/test/${params.value}`}
                    >
                      {params.value}
                    </a>
                  </>
                );
              },
            },
            {
              field: "assignee",
              headerName: "Assignee",
              flex: 1,
              renderCell: (params: GridRenderCellParams<any>) => {
                return params.value !== null ? params.value : "";
              },
            },

            {
              field: "timestamp",
              headerName: "Last Updated",
              flex: 1,
              renderCell: (params: GridRenderCellParams<any>) => {
                return dayjs(params.value).toString();
              },
            },
          ]}
          dataGridProps={{
            getRowId: (el: any) =>
              `${el.metadata.number}-${el.testCase}-${el.testClass}`,
          }}
          showFooter={true}
          pageSize={100}
        />
      </Grid2>
    </Grid2>
  );
}

export default function Page() {
  const router = useRouter();

  const defaultStartTime = dayjs().subtract(6, "month");
  const [startTime, setStartTime] = useState(defaultStartTime);
  const defaultStopTime = dayjs();
  const [stopTime, setStopTime] = useState(defaultStopTime);
  const [timeRange, setTimeRange] = useState<number>(180);
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [baseUrl, setBaseUrl] = useState<string>("");

  const [state, setState] = useState<string>(DEFAULT_ISSUE_STATE);
  const [platform, setPlatform] = useState<string>(DEFAULT_PLATFORM);
  const [label, setLabel] = useState<string>(DEFAULT_LABEL);
  const [triaged, setTriaged] = useState<string>(DEFAULT_TRIAGED_STATE);

  // Set the dropdown value what is in the param
  useEffect(() => {
    const startTime: string = (router.query.startTime as string) ?? undefined;
    if (startTime !== undefined) {
      setStartTime(dayjs(startTime));

      if (dayjs(startTime).valueOf() !== defaultStartTime.valueOf()) {
        setTimeRange(-1);
      }
    }

    const stopTime: string = (router.query.stopTime as string) ?? undefined;
    if (stopTime !== undefined) {
      setStopTime(dayjs(stopTime));

      if (dayjs(stopTime).valueOf() !== defaultStopTime.valueOf()) {
        setTimeRange(-1);
      }
    }

    const granularity: Granularity =
      (router.query.granularity as Granularity) ?? undefined;
    if (granularity !== undefined) {
      setGranularity(granularity);
    }

    const state: string = (router.query.state as string) ?? undefined;
    if (state !== undefined) {
      setState(state);
    }

    const platform: string = (router.query.platform as string) ?? undefined;
    if (platform !== undefined) {
      setPlatform(platform);
    }

    const label: string = (router.query.label as string) ?? undefined;
    if (label !== undefined) {
      setLabel(label);
    }

    const triaged: string = (router.query.triaged as string) ?? undefined;
    if (triaged !== undefined) {
      setTriaged(triaged);
    }

    setBaseUrl(
      `${window.location.protocol}//${
        window.location.host
      }${router.asPath.replace(/\?.+/, "")}`
    );
  }, [router.query]);

  const queryParams: { [key: string]: any } = {
    label: label !== DEFAULT_LABEL ? label : "skipped",
    platform: platform !== DEFAULT_PLATFORM ? platform : "",
    repo: "pytorch/pytorch",
    state: state,
    startTime: dayjs(startTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: dayjs(stopTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    triaged: triaged !== DEFAULT_TRIAGED_STATE ? triaged : "",
  };

  const queryName = "disabled_test_labels";

  let { data, error, isLoading } = useClickHouseAPI(
    queryName,
    { repo: queryParams.repo },
    true,
    {
      refreshInterval: 60 * 60 * 1000, // refresh every hour
    }
  );

  if (error) {
    return (
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"1rem"} fontStyle={"italic"}>
          Failed to load disabled test labels
        </Typography>
      </Stack>
    );
  }

  if (isLoading) {
    return (
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"1rem"} fontStyle={"italic"}>
          Loading disabled test labels...
        </Typography>
      </Stack>
    );
  }

  // Get the list of labels from these disabled issues
  const acceptLabels = getLabels(data);

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          PyTorch Disabled Tests DashBoard
        </Typography>
        <CopyLink
          textToCopy={`${baseUrl}?${encodeParams({
            startTime: startTime.toString(),
            stopTime: stopTime.toString(),
            granularity: granularity,
            state: state,
            platform: platform,
            label: label,
            triaged: triaged,
          })}`}
        />
      </Stack>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <TimeRangePicker
          startTime={startTime}
          setStartTime={setStartTime}
          stopTime={stopTime}
          setStopTime={setStopTime}
          timeRange={timeRange}
          setTimeRange={setTimeRange}
        />
        <ValuePicker
          value={platform}
          setValue={setPlatform}
          values={PLATFORMS}
          label={"Platform"}
        />
        <ValuePicker
          value={label}
          setValue={setLabel}
          values={acceptLabels}
          label={"Label"}
        />
        <ValuePicker
          value={triaged}
          setValue={setTriaged}
          values={TRIAGED_STATES}
          label={"Triaged?"}
        />
      </Stack>
      <GraphPanel queryParams={{ ...queryParams, state: "not used" }} />
      <Stack direction="row" spacing={2}>
        <ValuePicker
          value={state}
          setValue={setState}
          values={ISSUE_STATES}
          label={"State"}
        />
      </Stack>
      <DisabledTestsPanel queryParams={queryParams} />
    </Stack>
  );
}
