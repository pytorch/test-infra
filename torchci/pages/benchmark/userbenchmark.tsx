import { Grid } from "@mui/material";
import TimeSeriesPanel from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { RocksetParam } from "lib/rockset";
import React, { useState } from "react";
import styles from "components/hud.module.css";

const MAX_BRIGHTNESS: number = 255;

type UserbenchmarkRow = {
  metric_name: string;
  control_value: string | number;
  treatment_value: string | number;
  speedup: string | number | null;
};

export const USERBENCHMARKS: { [k: string]: string } = {
  torch_trt: "Torch TensorRT",
};

type UserbenchmarkProps = {};
type UserbenchmarkState = { url: string | null; content: any };

class UserbenchmarkReport extends React.Component<
  UserbenchmarkProps,
  UserbenchmarkState
> {

  constructor(props: UserbenchmarkProps) {
    super(props);

    this.state = {
      url: null,
      content: null,
    };
  }

  // returns a list[UserbenchmarkRow]
  // The first element is headers, remaining elements are rows.
  // 1 header row is expected, followed by data rows.

  getHeader(row: UserbenchmarkRow) {
    const headers = [
      row.metric_name as string,
      row.base_value as string,
      row.pr_value as string,
      row.speedup as string,
    ];
    return (
      <thead>
        <tr className={styles.userbenchmarkTable}>
          {headers.map((val: string, idx: number) => (
            <th className={styles.userbenchmarkTable} key={idx}>
              {val}
            </th>
          ))}
        </tr>
      </thead>
    );
  }

  getRow(row: UserbenchmarkRow, minSpeedup: number, maxSpeedup: number) {
    const convertSpeedup = (speedupRaw: number) => {
      if (typeof speedupRaw === "number") {
        const text = (speedupRaw * 100).toFixed(2) + "%";
        // assign a color
        let color = `rgb(${MAX_BRIGHTNESS}, ${MAX_BRIGHTNESS}, ${MAX_BRIGHTNESS})`;
        if (speedupRaw >= 0) {
          const ratio = speedupRaw / maxSpeedup;
          const otherColor = Math.floor(
            MAX_BRIGHTNESS * (1 - ratio)
          ).toString();
          color = `rgb(${otherColor}, ${MAX_BRIGHTNESS}, ${otherColor})`;
        } else {
          const ratio = speedupRaw / minSpeedup;
          const otherColor = Math.floor(
            MAX_BRIGHTNESS * (1 - ratio)
          ).toString();
          color = `rgb(${MAX_BRIGHTNESS}, ${otherColor}, ${otherColor})`;
        }
        return (
          <td
            style={{ backgroundColor: color }}
            className={styles.userbenchmarkTable}
          >
            {text}
          </td>
        );
      } else {
        return <td className={styles.userbenchmarkTable}>{speedupRaw}</td>;
      }
    };
    return (
      <tbody>
        <tr className={styles.userbenchmarkTable}>
          {[row.metric_name, row.base_value, row.pr_value].map(
            (val: any, idx: number) => (
              <td className={styles.userbenchmarkTable} key={idx}>
                {val}
              </td>
            )
          )}
          {convertSpeedup(row.speedup as number)}
        </tr>
      </tbody>
    );
  }

  csvToTable(csvString: string) {
    const data = this.parseCsv(csvString);

    const minSpeedup = Math.min(
      0.0,
      ...data
        .slice(1)
        .map((subarr: UserbenchmarkRow) => subarr.speedup as number)
    );
    const maxSpeedup = Math.max(
      0.0,
      ...data
        .slice(1)
        .map((subarr: UserbenchmarkRow) => subarr.speedup as number)
    );
    return (
      <table className={styles.userbenchmarkTable}>
        {this.getHeader(data[0])}
        {data.slice(1).map((row) => this.getRow(row, minSpeedup, maxSpeedup))}
      </table>
    );
  }

  componentDidMount() {
    let url: string | null = null;
    if (typeof document !== "undefined") {
      const searchParams = new URL(document.location.toString()).searchParams;
      if (searchParams.has("url")) {
        url = searchParams.get("url");
      }
    }

    if (typeof url === "string") {
      fetch(url)
        .then((response) => {
          const text = response.text();
          return text;
        })
        .then((response) => {
          this.setState({
            content: this.csvToTable(response),
            url: url,
          });
        });
    }
  }

  render() {
    return (
      <div>
        <h1>
          {" "}
          Userbenchmark results from <span>{this.state.url}</span>{" "}
        </h1>
        <p>
          Userbenchmarks can be optionally run in the CI by adding
          &quot;RUN_TORCHBENCH: [userbenchmark]&quot; in the body of PRs in the
          pytorch/pytorch repo, where [userbenchmark] should be replaced by one
          of the userbenchmark options, e.g. nvfuser. The CI job will generate a
          CSV of the results, showing result times from the base revision as
          well as the PR revision. This page displays the speedup/slowdown by
          comparing the base and PR revision results.
        </p>
        <div> {this.state.content} </div>
      </div>
    );
  }
}

export default function Userbenchmark() {
  return <div>
    <UserbenchmarkReport />
  </div>;
}
