import { queryClickhouse } from "lib/clickhouse";
import _ from "lodash";
import type { NextApiRequest, NextApiResponse } from "next";
import pLimit from "p-limit";
import zlib from "zlib";

const SUPPORTED_WORKFLOWS = ["periodic", "pull", "trunk", "slow", "inductor"];

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const startDate = req.query.startDate as string;
  const endDate = req.query.endDate as string;
  const data = await getInfo(parseInt(startDate), parseInt(endDate));
  res
    .status(200)
    .setHeader("Content-Encoding", "gzip")
    .send(zlib.gzipSync(JSON.stringify(data)));
}

const JOBS_ON_SHAS = `
select distinct
regexp_replace(
  name,
  '(\\\\([^,]+, )(?:[0-9]+, )*(?:lf\\\\.)?([^)]+\\\\))',
  '\\\\1\\\\2'
) AS name, head_sha as sha from default.workflow_job
where id in (select id from materialized_views.workflow_job_by_head_sha where head_sha in {shas: Array(String)})
and workflow_name in {supported_workflows: Array(String)}
`;

async function getInfo(startDate: number, endDate: number) {
  // Get commits for each workflow in parallel
  let allPyTorchCommits: { sha: string; push_date: number }[] =
    await fetchJSONLines(
      `https://ossci-raw-job-status.s3.us-east-1.amazonaws.com/additional_info/weekly_file_report2/commits_metadata.json.gz`
    );

  allPyTorchCommits = allPyTorchCommits.filter(
    (c) => c.push_date >= startDate && c.push_date <= endDate
  );

  const shaToDate = new Map(allPyTorchCommits.map((c) => [c.sha, c.push_date]));

  const workflowsOnShas = await queryClickhouse(JOBS_ON_SHAS, {
    shas: allPyTorchCommits.map((c) => c.sha),
    supported_workflows: SUPPORTED_WORKFLOWS,
  });

  // Group by workflow
  const shasByWorkflow = _(workflowsOnShas)
    .groupBy((s) => s.name)
    .values()
    .sortBy((vals) => vals.length)
    .value();

  // Get up to 20 evenly distributed SHAs from the workflow with fewest options
  const selectedShas = new Set<string>();
  selectedShas.add(
    workflowsOnShas.sort((row) => shaToDate.get(row.sha) || 0)[0].sha
  );
  selectedShas.add(
    workflowsOnShas.sort((row) => -(shaToDate.get(row.sha) || 0))[0].sha
  );

  // Calculate intervals for coverage check
  const allDates = allPyTorchCommits.map((c) => c.push_date);
  const minDate = Math.min(...allDates);
  const maxDate = Math.max(...allDates);
  const numIntervals = 10;
  const intervalSize = (maxDate - minDate) / numIntervals;

  // Helper to find largest gap and pick SHA in between
  function fillGaps(
    existingShas: string[],
    allAvailableShas: string[],
    targetCount: number
  ): void {
    const result = [...existingShas];
    const needed = targetCount - existingShas.length;

    // Sort existing SHAs by push_date
    const sortedExisting = result
      .map((sha) => ({ sha, push_date: shaToDate.get(sha) || 0 }))
      .sort((a, b) => a.push_date - b.push_date);

    for (let i = 0; i < needed; i++) {
      // Collect all gaps with their indices
      const gaps: { gap: number; startIdx: number }[] = [];
      for (let j = 0; j < sortedExisting.length - 1; j++) {
        const gap =
          sortedExisting[j + 1].push_date - sortedExisting[j].push_date;
        gaps.push({ gap, startIdx: j });
      }

      // Sort gaps by size (descending)
      gaps.sort((a, b) => b.gap - a.gap);

      // Try each gap in order until we find a candidate SHA
      let candidateSha = null;
      let gapStartIdx = -1;

      for (const { startIdx } of gaps) {
        const startDate = sortedExisting[startIdx].push_date;
        const endDate = sortedExisting[startIdx + 1].push_date;
        const midDate = (startDate + endDate) / 2;

        // Find available SHA closest to midpoint
        const candidate = allAvailableShas
          .filter((sha) => {
            const date = shaToDate.get(sha);
            return (
              date &&
              date > startDate &&
              date < endDate &&
              !result.includes(sha)
            );
          })
          .map((sha) => ({
            sha,
            distance: Math.abs((shaToDate.get(sha) || 0) - midDate),
          }))
          .sort((a, b) => a.distance - b.distance)[0];

        if (candidate) {
          candidateSha = candidate;
          gapStartIdx = startIdx;
          break;
        }
      }

      if (!candidateSha) break;

      result.push(candidateSha.sha);
      selectedShas.add(candidateSha.sha);
      sortedExisting.splice(gapStartIdx + 1, 0, {
        sha: candidateSha.sha,
        push_date: shaToDate.get(candidateSha.sha) || 0,
      });
    }

    // Second pass: Ensure each interval has at least one SHA
    // Only do this if we haven't already exceeded a reasonable limit
    const maxTotalShas = targetCount + 5; // Allow up to 5 extra for interval coverage

    for (let i = 0; i < numIntervals; i++) {
      if (result.length >= maxTotalShas) break;

      const intervalStart = minDate + i * intervalSize;
      const intervalEnd = minDate + (i + 1) * intervalSize;

      // Check if any selected SHA falls in this interval
      const hasShaMInInterval = result.some((sha) => {
        const date = shaToDate.get(sha);
        return date && date >= intervalStart && date < intervalEnd;
      });

      // If no SHA in this interval, find the closest one and add it
      if (!hasShaMInInterval) {
        const intervalMid = (intervalStart + intervalEnd) / 2;
        const closestSha = allAvailableShas
          .filter((sha) => {
            const date = shaToDate.get(sha);
            return (
              date &&
              date >= intervalStart &&
              date < intervalEnd &&
              !result.includes(sha)
            );
          })
          .map((sha) => ({
            sha,
            distance: Math.abs((shaToDate.get(sha) || 0) - intervalMid),
          }))
          .sort((a, b) => a.distance - b.distance)[0];

        if (closestSha) {
          result.push(closestSha.sha);
          selectedShas.add(closestSha.sha);
        }
      }
    }
  }

  // For each workflow, fill gaps up to 10 SHAs and ensure interval coverage
  _(shasByWorkflow).forEach((vals) => {
    const workflowShas = vals.map((v) => v.sha);
    // Find which of the base SHAs this workflow has
    const existingShas = Array.from(selectedShas).filter((sha) =>
      workflowShas.includes(sha)
    );
    // Fill gaps to get to 10, then ensure all intervals have coverage
    fillGaps(existingShas, workflowShas, 10);
  });

  const finalShas = Array.from(selectedShas);

  const limit = pLimit(10); // max 5 concurrent batch requests

  const results = await Promise.all(
    finalShas.map((sha) =>
      limit(async () => {
        try {
          return await fetchJSONLines(
            `https://ossci-raw-job-status.s3.us-east-1.amazonaws.com/additional_info/weekly_file_report2/data_${sha}.json.gz`
          ).then((data) =>
            data.map((item) => ({
              ...item,
              sha: sha,
            }))
          );
        } catch (error) {
          // console.error(`Error fetching data for ${sha.sha}:`, error);
          return [];
        }
      })
    )
  ).then((arrays) => arrays.flat());

  const newShas = allPyTorchCommits.filter((s) =>
    results.some((r) => r.sha === s.sha)
  );

  async function fetchJSONLines(url: string): Promise<any[]> {
    const res = await fetch(url);
    const text = await res.text();
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  }

  const costInfo = await fetchJSONLines(
    `https://ossci-metrics.s3.us-east-1.amazonaws.com/ec2_pricing.json.gz`
  );

  const testOwnerLabels = await fetchJSONLines(
    `https://ossci-metrics.s3.us-east-1.amazonaws.com/test_owner_labels/test_owner_labels.json.gz`
  );

  results.forEach((item) => {
    // find first label in item.labels that is in costInfo
    let label = "unknown";
    for (let l of item.labels) {
      if (l.startsWith("lf.")) {
        l = l.slice(3);
      }
      const costData = costInfo.find((cost) => cost.label === l);
      if (costData) {
        label = l;
        break;
      }
    }
    item.label = label;
    delete item.labels;
  });

  return {
    results,
    costInfo,
    shas: newShas,
    testOwnerLabels,
  };
}
