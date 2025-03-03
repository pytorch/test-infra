import { Stack } from "@mui/material";
import { BarChart } from "@mui/x-charts";
import { TextFieldSubmit } from "components/common/TextFieldSubmit";
import JobLinks from "components/JobLinks";
import JobSummary from "components/JobSummary";
import LoadingPage from "components/LoadingPage";
import LogViewer from "components/LogViewer";
import TestSearchForm from "components/tests/TestSearchForm";
import dayjs from "dayjs";
import { encodeParams, fetcher } from "lib/GeneralUtils";
import { JobData } from "lib/types";
import _ from "lodash";
import { useRouter } from "next/router";
import { TestInfoAPIResponse } from "pages/api/flaky-tests/3dStats";
import { useState } from "react";
import useSWRImmutable from "swr/immutable";

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
        return "#e15759";
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
    </Stack>
  );
}
