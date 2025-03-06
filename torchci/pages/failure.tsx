import { Button, TextField } from "@mui/material";
import { Box, Stack } from "@mui/system";
import CheckBoxSelector from "components/CheckBoxSelector";
import JobLinks from "components/JobLinks";
import JobSummary from "components/JobSummary";
import LoadingPage from "components/LoadingPage";
import LogViewer from "components/LogViewer";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { encodeParams } from "lib/GeneralUtils";
import { JobData } from "lib/types";
import { usePreference } from "lib/useGroupingPreference";
import { useRouter } from "next/router";
import { CSSProperties, useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import useSWR from "swr";
dayjs.extend(utc);

const fetcher = (url: string) => fetch(url).then((res) => res.json());

function formatFailureCaptures(failureCaptures: string) {
  // Format the failure captures to be string[] for the API
  try {
    let captures = JSON.parse(failureCaptures);
    if (captures instanceof Array) {
      return captures;
    } else {
      return [failureCaptures as string];
    }
  } catch (e) {
    return [failureCaptures as string];
  }
}

function FuzzySearchCheckBox({
  useFuzzySearch,
  setUseFuzzySearch,
}: {
  useFuzzySearch: boolean;
  setUseFuzzySearch: any;
}) {
  return (
    <CheckBoxSelector
      checkBoxName="useFuzzySearch"
      value={useFuzzySearch}
      setValue={() => {
        setUseFuzzySearch(!useFuzzySearch);
      }}
      labelText="Use fuzzy search"
    />
  );
}

function FailureInfo({
  totalCount,
  jobCount,
  samples,
}: {
  totalCount: number;
  jobCount: { [jobName: string]: number };
  samples: JobData[];
}) {
  const [jobsToShow, setJobsToShow] = useState(new Set<string>());
  const samplesToShow = samples.filter((sample) => {
    return jobsToShow.size == 0 || (sample.name && jobsToShow.has(sample.name));
  });

  // Populate the last 14 days
  const dayBuckets: Map<
    string,
    { highlighted: number; other: number; total: number }
  > = new Map();
  const branchHistogramByDay: Map<string, Map<string, number>> = new Map();
  for (let i = 13; i >= 0; i--) {
    const time = dayjs().local().subtract(i, "day").format("MM/D");
    dayBuckets.set(time, { highlighted: 0, other: 0, total: 0 });
    branchHistogramByDay.set(time, new Map());
  }

  // we highlight master branch
  const highlighted = new Set<string>();
  highlighted.add("master");
  highlighted.add("main");

  const branchNames = new Set<string>(highlighted);
  samplesToShow.forEach((job, _i) => {
    const time = dayjs(job.time!).local().format("MM/D");
    if (!dayBuckets.has(time)) {
      return;
    }
    const jobBranch = job.branch!;
    branchNames.add(jobBranch);
    const countInfo = dayBuckets.get(time);
    if (highlighted.has(jobBranch)) {
      countInfo!.highlighted += 1;
    } else {
      countInfo!.other += 1;
    }
    countInfo!.total += 1;

    const branchHistogramPerSample = branchHistogramByDay.get(time)!;
    if (!branchHistogramPerSample.has(jobBranch)) {
      branchHistogramPerSample.set(jobBranch, 0);
    }
    branchHistogramPerSample.set(
      jobBranch,
      branchHistogramPerSample.get(jobBranch)! + 1
    );
  });

  const data: any = [];
  dayBuckets.forEach((countInfo, date) => {
    data.push({ date: date, ...countInfo });
  });

  const barColor = (highlight: boolean) => {
    if (highlight) {
      return "#e41a1c";
    } else {
      return "#8884d8";
    }
  };

  const CustomTooltip = ({ active, payload, label }: any) => {
    const finalStyle: CSSProperties = {
      margin: 0,
      padding: 10,
      backgroundColor: "#fff",
      border: "1px solid #ccc",
      whiteSpace: "nowrap",
    };
    const finalItemStyle = {
      display: "block",
      paddingTop: 4,
      paddingBottom: 4,
    };
    const listStyle = { padding: 0, margin: 0 };
    if (active && payload && payload.length) {
      return (
        <div className="recharts-default-tooltip" style={finalStyle}>
          <div className="recharts-tooltip-label"> {label} </div>
          <div>
            <ul className="recharts-tooltip-item-list" style={listStyle}>
              {Array.from(branchNames)
                .filter((bn: string) => {
                  return branchHistogramByDay
                    .get(payload[0].payload.date)!
                    .has(bn);
                })
                .map((bn: any, i: any) => {
                  return (
                    <li
                      className="recharts-tooltip-item"
                      key={`tooltip-item-${i}`}
                      style={{
                        color: barColor(highlighted.has(bn)),
                        ...finalItemStyle,
                      }}
                    >
                      <span className="recharts-tooltip-item-name">{bn}</span>
                      <span className="recharts-tooltip-item-separator">
                        {" "}
                        :{" "}
                      </span>
                      <span className="recharts-tooltip-item-value">
                        {branchHistogramByDay
                          .get(payload[0].payload.date)!
                          .get(bn)}
                      </span>
                    </li>
                  );
                })}
            </ul>
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <div>
      <div>
        <h3>Failure count </h3>
        <BarChart width={800} height={150} data={data}>
          <Tooltip content={<CustomTooltip />} />
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <Bar
            yAxisId="left"
            dataKey="other"
            stackId="a"
            fill={barColor(false)}
          />
          <Bar
            yAxisId="left"
            dataKey="highlighted"
            stackId="a"
            fill={barColor(true)}
          />
          <XAxis dataKey="date" interval={0} />
          <YAxis yAxisId="left" dataKey="total" allowDecimals={false} />
          <YAxis
            yAxisId="right"
            dataKey="total"
            orientation="right"
            allowDecimals={false}
          />
        </BarChart>

        <h3>Failures by job</h3>
        <table>
          <tbody>
            {Object.entries(jobCount)
              .sort(function ([jobAName, jobACount], [jobBName, jobBCount]) {
                if (jobACount != jobBCount) {
                  return jobBCount - jobACount;
                }
                return jobAName.localeCompare(jobBName);
              })
              .map(([job, count]) => (
                <tr
                  key={job}
                  onClick={() => {
                    if (jobsToShow.has(job)) {
                      const newSet = new Set(jobsToShow);
                      newSet.delete(job);
                      setJobsToShow(newSet);
                    } else {
                      setJobsToShow(new Set(jobsToShow).add(job));
                    }
                  }}
                >
                  <td>
                    <input
                      type="checkbox"
                      name={`show-${job}`}
                      checked={jobsToShow.has(job)}
                      onChange={() => {}}
                    ></input>
                  </td>
                  <td>{job}</td>
                  <td>{count as number}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <h3>Failures ({totalCount} total)</h3>
      <ul>
        {samplesToShow
          // Keep the most recent samples on top
          .sort(function (sampleA: JobData, sampleB: JobData) {
            if (sampleA.time == sampleB.time) {
              return 0;
            }
            return dayjs(sampleA.time).isBefore(dayjs(sampleB.time)) ? 1 : -1;
          })
          .map((sample) => (
            <li key={sample.id}>
              <JobSummary
                job={sample}
                highlight={
                  sample.branch ? highlighted.has(sample.branch) : false
                }
                unstableIssues={[]}
              />
              <div>
                <JobLinks job={sample} showCommitLink={true} />
              </div>
              <LogViewer job={sample} />
            </li>
          ))}
      </ul>
    </div>
  );
}

function getTestInfo(failureCapture: string) {
  const pytestFailureRe = /.*.py::(.*)::(test_\w*)/;
  const match = failureCapture.match(pytestFailureRe);
  if (match == null) {
    return null;
  }
  return {
    moduleName: match[1],
    testName: match[2],
  };
}

function setURL(name: string, jobName: string, failureCaptures: string) {
  window.location.href = `/failure?${encodeParams({
    name,
    jobName,
    failureCaptures,
  })}`;
}

export default function Page() {
  const router = useRouter();
  const name = router.query.name as string;
  const jobName = router.query.jobName as string;
  const failureCaptures = router.query.failureCaptures as string;
  const [testInfo, setTestInfo] = useState<any>(null);

  const [useFuzzySearch, setUseFuzzySearch] = usePreference(
    "useFuzzySearch",
    false
  );
  // `capture` is undefined pre-hydration, so we need to conditionally fetch in
  // `useSWR` to avoid sending a garbage request to the server.
  const swrKey =
    failureCaptures !== undefined
      ? `/api/failure?${encodeParams({
          name,
          jobName,
          failureCaptures: JSON.stringify(
            formatFailureCaptures(failureCaptures)
          ),
          useFuzzySearch: useFuzzySearch.toString(),
        })}`
      : null;
  const { data } = useSWR(swrKey, fetcher);

  useEffect(() => {
    if (failureCaptures) {
      setTestInfo(
        getTestInfo(formatFailureCaptures(failureCaptures as string)[0])
      );
    }
  }, [failureCaptures]);

  if (!router.isReady) {
    return <LoadingPage />;
  }

  return (
    <Stack spacing={1}>
      <h1>PyTorch CI Failure Info</h1>
      <p>Search for log classifier results</p>
      <Box
        component="form"
        noValidate
        autoComplete="off"
        sx={{
          "& .MuiTextField-root": { m: 1 },
          "& .MuiButton-root": { m: 2 },
        }}
        onSubmit={(e) => {
          e.preventDefault();
          // @ts-ignore
          setURL(e.target[0].value, jobName, e.target[2].value);
        }}
      >
        <Stack spacing={1}>
          <TextField label="Job" defaultValue={name} />
          <TextField label="Failure Captures" defaultValue={failureCaptures} />
          <Button
            variant="contained"
            color="primary"
            type="submit"
            style={{ width: "max-content" }}
          >
            Search
          </Button>
        </Stack>
      </Box>
      {testInfo && (
        <div>
          <a
            href={`/tests/search?${encodeParams({
              name: testInfo.testName,
              suite: testInfo.moduleName,
            })}`}
          >
            More Failures Page for {testInfo.testName}
          </a>
        </div>
      )}
      <FuzzySearchCheckBox
        useFuzzySearch={useFuzzySearch}
        setUseFuzzySearch={setUseFuzzySearch}
      />
      <em>Showing last 14 days of data.</em>
      {data === undefined ? (
        <div>Loading...</div>
      ) : (
        <FailureInfo
          totalCount={data.totalCount}
          jobCount={data.jobCount}
          samples={data.samples}
        />
      )}
    </Stack>
  );
}
