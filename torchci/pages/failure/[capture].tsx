import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
dayjs.extend(utc);

import { useRouter } from "next/router";
import useSWR from "swr";
import { BarChart, Bar, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";

import { JobData } from "lib/types";
import JobSummary from "components/JobSummary";
import LogViewer from "components/LogViewer";
import JobLinks from "components/JobLinks";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

function FailureInfo({
  totalCount,
  jobCount,
  samples,
}: {
  totalCount: number;
  jobCount: { [jobName: string]: number };
  samples: JobData[];
}) {
  // Populate the last 14 days
  const dayBuckets: Map<string, number> = new Map();
  for (let i = 13; i >= 0; i--) {
    const time = dayjs().local().subtract(i, "day").format("MM/D");
    dayBuckets.set(time, 0);
  }

  samples.forEach((job) => {
    const time = dayjs(job.time!).local().format("MM/D");
    if (!dayBuckets.has(time)) {
      return;
    }
    dayBuckets.set(time, dayBuckets.get(time)! + 1);
  });

  const data: any = [];
  dayBuckets.forEach((count, date) => {
    data.push({ date, count });
  });

  return (
    <div>
      <div>
        <h3>Failure count </h3>
        <BarChart width={800} height={150} data={data}>
          <Tooltip />
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <Bar yAxisId="left" dataKey="count" fill="#8884d8" />
          <XAxis dataKey="date" interval={0} />
          <YAxis yAxisId="left" dataKey="count" allowDecimals={false} />
          <YAxis
            yAxisId="right"
            dataKey="count"
            orientation="right"
            allowDecimals={false}
          />
        </BarChart>

        <h3>Failures by job</h3>
        <table>
          <tbody>
            {Object.entries(jobCount).map(([job, count]) => (
              <tr key={job}>
                <td>{job}</td>
                <td>{count as number}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Failures ({totalCount} total)</h3>
      <ul>
        {samples.map((sample) => (
          <li key={sample.id}>
            <JobSummary job={sample} />
            <div>
              <JobLinks job={sample} />
            </div>
            <LogViewer job={sample} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Page() {
  const router = useRouter();
  const capture = router.query.capture;

  // `capture` is undefined pre-hydration, so we need to conditionally fetch in
  // `useSWR` to avoid sending a garbage request to the server.
  const swrKey =
    capture !== undefined
      ? `/api/failure/${encodeURIComponent(capture as string)}`
      : null;
  const { data } = useSWR(swrKey, fetcher);
  return (
    <div>
      <h1>PyTorch CI Failure Info</h1>
      <h2>
        <code>{capture}</code>
      </h2>
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
    </div>
  );
}
