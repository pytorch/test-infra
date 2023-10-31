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
  delta: string | number | null;
};

export const USERBENCHMARKS: { [k: string]: string } = {
  torch_trt: "Torch TensorRT",
};

type UserbenchmarkState = { url: string | null; content: any };

class UserbenchmarkReport extends React.Component<
  UserbenchmarkState
> {

  // returns a list[UserbenchmarkRow]
  // The first element is headers, remaining elements are rows.
  // 1 header row is expected, followed by data rows.

  getHeader(row: UserbenchmarkRow) {
    const headers = [
      row.metric_name as string,
      row.control_value as string,
      row.treatment_value as string,
      row.delta as string,
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
          {[row.metric_name, row.control_value, row.treatment_value].map(
            (val: any, idx: number) => (
              <td className={styles.userbenchmarkTable} key={idx}>
                {val}
              </td>
            )
          )}
          {convertSpeedup(row.delta as number)}
        </tr>
      </tbody>
    );
  }

  jsonToTable(csvString: string) {
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
            content: "abc",
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
          TorchBench Userbenchmark results from <span>{this.state.url}</span>{" "}
        </h1>
        <p>
          TorchBench Userbenchmarks can be run in the CI deployed in the pytorch/benchmark
          repo. The CI job will generate a JSON of the results, showing result times
          from the control revision as well as the treatment revision.
          This page displays the metrics delta by comparing the revision results.
        </p>
        <div> {this.state.content} </div>
      </div>
    );
  }
}

export default function Page() {
  return <div>
    <UserbenchmarkReport />
  </div>;
}
