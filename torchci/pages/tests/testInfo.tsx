import { Grid2, List, ListItem, Stack, Typography } from "@mui/material";
import { BarChart } from "@mui/x-charts";
import { TextFieldSubmit } from "components/common/TextFieldSubmit";
import GranularityPicker from "components/GranularityPicker";
import JobLinks from "components/JobLinks";
import JobSummary from "components/JobSummary";
import LoadingPage from "components/LoadingPage";
import LogViewer from "components/LogViewer";
import TestSearchForm from "components/tests/TestSearchForm";
import dayjs from "dayjs";
import {
  encodeParams,
  fetcher,
  useClickHouseAPIImmutable,
} from "lib/GeneralUtils";
import { JobData } from "lib/types";
import _ from "lodash";
import { useRouter } from "next/router";
import { TestInfoAPIResponse } from "pages/api/flaky-tests/3dStats";
import { TimeRangePicker } from "pages/metrics";
import { memo, useState } from "react";
import useSWRImmutable from "swr/immutable";

const RED = "#e15759";

function convertToSeries(data: TestInfoAPIResponse) {
  data = data.sort((a, b) => dayjs(a.hour).unix() - dayjs(b.hour).unix());
  const xAxis = [
    {
      data: data.map((d) => dayjs(d.hour).format("YYYY-MM-DD HH:mm")),
      scaleType: "band",
    },
  ];
  const allConclusions = _.uniq(
    _.flatten(data.map((d) => Object.keys(d.conclusions)))
  );

  function getColorForConclusion(conclusion: string) {
    switch (conclusion) {
      case "failed":
        return RED;
      case "flaky":
        return "#f28e2c";
      case "skipped":
        return "#bab0ab";
      case "success":
        return "#59a14f";
      default:
        return "black";
    }
  }

  const series = allConclusions.map((conclusion) => {
    return {
      label: conclusion,
      stack: "total",
      data: data.map((d) => d.conclusions[conclusion] ?? 0),
      color: getColorForConclusion(conclusion),
    };
  });

  return { xAxis, series };
}

const FailuresTimeline = memo(function FailuresTimeline({
  name,
  suite,
  file,
}: {
  name: string;
  suite: string;
  file: string;
}) {
  const [jobFilter, setJobFilter] = useState<string>("");
  const [granularity, setGranularity] = useState<string>("week");
  const [startTime, setStartTime] = useState(dayjs().subtract(1, "year"));
  const [stopTime, setStopTime] = useState(dayjs());
  const [timeRange, setTimeRange] = useState<number>(365);
  const [clickedTime, setClickedTime] = useState<string | null>(null);
  const height = 400;

  interface FailuresTimelineData {
    date: string;
    count: number;
    shas: string[];
  }

  let { data, isLoading } = useClickHouseAPIImmutable<FailuresTimelineData>(
    "flaky_tests/failures_timeline",
    {
      name,
      suite,
      file,
      jobFilter: `%${jobFilter}%`,
      granularity,
      startTime: startTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
      stopTime: stopTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    }
  );

  data = (data || []).map((d) => {
    d.date = dayjs(d.date).format("YYYY-MM-DD HH:mm");
    return d;
  });

  function getAxisAndSeries(data: FailuresTimelineData[]) {
    // Get the axis and the series in a format that is accepted by the chart.
    // Also fill in missing dates with 0s

    // Generate all dates of the granularity between the earliest and latest
    // dates found in the data
    const start = _.minBy(data, (d) => dayjs(d.date))?.date;
    const end = _.maxBy(data, (d) => dayjs(d.date))?.date;
    const allDates = [];
    let current = dayjs(start);
    while (current <= dayjs(end)) {
      allDates.push(current.format("YYYY-MM-DD HH:mm"));
      current = current.add(1, granularity as any);
    }

    // Fill in missing dates with 0s
    const dataMap = _.keyBy(data, (d) =>
      dayjs(d.date).format("YYYY-MM-DD HH:mm")
    );
    data = allDates.map((date) => {
      return {
        date,
        count: dataMap[date]?.count ?? 0,
        shas: dataMap[date]?.shas ?? [],
      };
    });

    const xAxis = [
      {
        data: data.map((d) => d.date),
        scaleType: "band",
      },
    ];
    const series = [
      {
        label: "Failures",
        stack: "total",
        data: data.map((d) => d.count),
        color: RED,
      },
    ];
    return { xAxis, series };
  }

  const { series, xAxis } = getAxisAndSeries(data);
  return (
    <Stack spacing={2}>
      <h2>Failures Timeline (Beta)</h2>
      <Typography>
        This shows the number of failures for the test on non
        `rerun_disabled_tests` jobs. If a test failed and succeded on rerun, it
        will still show up here. Data only exists after around March 2023. Click
        on a bar to see the first 10 commits for that date.
      </Typography>
      <Stack spacing={2}>
        <Stack direction="row" spacing={2}>
          <TimeRangePicker
            startTime={startTime}
            setStartTime={setStartTime}
            stopTime={stopTime}
            setStopTime={setStopTime}
            timeRange={timeRange}
            setTimeRange={setTimeRange}
            setGranularity={setGranularity}
          />
          <GranularityPicker
            granularity={granularity}
            setGranularity={setGranularity}
          />
        </Stack>
        <TextFieldSubmit
          textFieldValue={jobFilter}
          onSubmit={setJobFilter}
          info={"Chart Job Filter"}
        />
      </Stack>
      {isLoading ? (
        <LoadingPage height={height} />
      ) : data.length == 500 ? (
        <Typography height={height}>
          Too many results, please reduce the time range or granularity
        </Typography>
      ) : (
        <Grid2 container>
          <Grid2 size={{ xs: 10 }}>
            <BarChart
              height={height}
              series={series}
              xAxis={xAxis as any}
              onAxisClick={(_e, d) => {
                setClickedTime(d?.axisValue as string);
              }}
            />
          </Grid2>
          <Grid2 size={{ xs: 2 }}>
            {clickedTime && (
              <>
                <Typography>
                  Showing first 10 commits for {clickedTime}
                </Typography>
                <List style={{ maxHeight: height, overflow: "auto" }}>
                  {data
                    .find((d) => d.date == clickedTime)
                    ?.shas.map((sha) => (
                      <ListItem key={sha}>
                        <a href={`/commit/${sha}`}>{sha}</a>
                      </ListItem>
                    ))}
                </List>
              </>
            )}
          </Grid2>
        </Grid2>
      )}
    </Stack>
  );
});

export default function Page() {
  const router = useRouter();
  const name = (router.query.name || "%") as string;
  const suite = (router.query.suite || "%") as string;
  const file = (router.query.file || "%") as string;
  const [jobFilter, setJobFilter] = useState<string>("");

  const swrKey = `/api/flaky-tests/3dStats?${encodeParams({
    name,
    suite,
    file,
    jobFilter,
  })}`;
  const { data: last3dStats, isLoading } = useSWRImmutable<TestInfoAPIResponse>(
    swrKey,
    fetcher
  );
  const { data: failureInfo, isLoading: failureInfoIsLoading } =
    useSWRImmutable<JobData[]>(
      `/api/flaky-tests/failures?${encodeParams({
        name,
        suite,
        file,
        limit: "100",
      })}`,
      fetcher
    );

  if (!router.isReady) {
    return <LoadingPage />;
  }

  const { series: last3dStatsSeries, xAxis: last3dStatsxAxis } =
    convertToSeries(last3dStats ?? []);

  return (
    <Stack spacing={2}>
      <h1>Test Info</h1>
      <TestSearchForm name={name} suite={suite} file={file} />
      <h2>Last 3 Days on main Branch</h2>
      <TextFieldSubmit
        textFieldValue={jobFilter}
        onSubmit={setJobFilter}
        info={"Chart Job Filter"}
      />
      {isLoading ? (
        <LoadingPage />
      ) : (
        <BarChart
          height={400}
          series={last3dStatsSeries}
          xAxis={last3dStatsxAxis as any}
        />
      )}

      <h2>Failures and Reruns on All Branches</h2>
      {failureInfoIsLoading ? (
        <LoadingPage />
      ) : (
        <>
          <div>Showing {(failureInfo ?? []).length} results</div>
          <ul>
            {(failureInfo ?? []).map((job) => (
              <li key={job.id} id={job.id}>
                <JobSummary
                  job={job}
                  highlight={job.branch == "main"}
                  unstableIssues={[]}
                />
                <div>
                  <JobLinks job={job} showCommitLink={true} />
                </div>
                <LogViewer job={job} />
              </li>
            ))}
          </ul>
        </>
      )}
      <FailuresTimeline name={name} suite={suite} file={file} />
    </Stack>
  );
}
