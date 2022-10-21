import { Grid } from "@mui/material";
import TimeSeriesPanel from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { RocksetParam } from "lib/rockset";
import React, { useState } from "react";
import styles from "components/hud.module.css";

const ROW_HEIGHT = 240;

class UserbenchmarkResults extends React.Component {
    constructor(props) {
        super(props);

        this.state = {
            url: null,
            content: null,
        };
    }

    // returns a list[list[data]]
    // outer list: first a row of headers; and then rows of data.
    // data order in the inner list:
    //   0. Metric name
    //   1. Base revision latency
    //   2. PR revision latency
    //   3. Speedup from the PR revision
    parseCsv(msg) {
        let as_array = msg.split("\n").map(x => x.split(";"));
        as_array = as_array.filter(subarray => subarray.length == 3);
        as_array[0].push("Speedup");
        for (let i=1; i<as_array.length; ++i) {
            for (let j=1; j<=2; ++j) {
                as_array[i][j] = parseFloat(as_array[i][j]);
            }
            as_array[i].push(as_array[i][1] / as_array[i][2] - 1);
        }
        return as_array;
    }

    getHeader(row) {
        const metric_header = row[0];
        const base_revision = row[1] + " (base)";
        const change_revision = row[2] + " (change)";
        const speedup_header = row[3];
        const headers = [metric_header, base_revision, change_revision, speedup_header]
        return (
            <thead>
                <tr className={styles.userbenchmarkTable}>
                    {headers.map((val, idx) => (
                        <th className={styles.userbenchmarkTable} key={idx}>{val}</th>
                    ))}
                </tr>
            </thead>
        );
    }

    getRow(row, minSpeedup, maxSpeedup) {
        const convertSpeedup = (speedupRaw) => {
            if (typeof speedupRaw === 'number') {
                const text = (speedupRaw * 100).toFixed(2) + '%';
                // assign a color
                let color = "rgb(255, 255, 255)";
                if (speedupRaw >= 0) {
                    const ratio = speedupRaw / maxSpeedup;
                    const otherColor = parseInt(255 * (1 - ratio)).toString();
                    color = "rgb(" + otherColor + ", 255, " + otherColor + ")";
                } else {
                    const ratio = speedupRaw / minSpeedup;
                    const otherColor = parseInt(255 * (1 - ratio)).toString();
                    color = "rgb(255, " + otherColor + ", " + otherColor + ")";
                }
                return <td style={{backgroundColor: color}} className={styles.userbenchmarkTable}>{text}</td>;
            } else {
                console.log("error out");
                return <td className={styles.userbenchmarkTable}>{speedupRaw}</td>;
            }
        };
        return (
            <tbody>
                <tr className={styles.userbenchmarkTable}>
                    {row.slice(0, 3).map((val, idx) => (
                        <td className={styles.userbenchmarkTable} key={idx}>{val}</td>
                    ))}
                    {convertSpeedup(row[3])}
                </tr>
            </tbody>
        );
    }

    csvToTable(csvString) {
        const data = this.parseCsv(csvString);

        const minSpeedup = Math.min(...data.slice(1).map(subarr => subarr[3]), 0.0)
        const maxSpeedup = Math.max(...data.slice(1).map(subarr => subarr[3]), 0.0)
        return (
            <table className={styles.userbenchmarkTable}>
                {this.getHeader(data[0])}
                {data.slice(1).map(row => this.getRow(row, minSpeedup, maxSpeedup))}
            </table>
        );
    }

    componentDidMount() {
        let url = null;
        if (typeof document !== 'undefined') {
            const searchParams = (new URL(document.location)).searchParams;
            if (!searchParams.has("url")) {
                console.log("!has_url");
                // setDataMessage("No URL provided (e.g. ?url=[...])")
                return;
            }
            url = searchParams.get("url");
        }


        if (typeof url === 'string') {
            console.log(url)
            fetch(url)
                .then((response) => {
                    const text = response.text();
                    return text;
                }).then((response) => {
                    this.setState({
                        content: this.csvToTable(response),
                        url: url,
                    })
                })
        }
    }

    render() {
        return (
            <div>
                <h1> Userbenchmark results from <span>{this.state.url}</span> </h1>
                <p>
                    Userbenchmarks can be optionally run in the CI by adding
                    &quot;RUN_TORCHBENCH: [userbenchmark]&quot; in the body of PRs
                    in the pytorch repo, where [userbenchmark] should be replaced
                    by one of the userbenchmark options, e.g. nvfuser. The CI job
                    will generate a CSV of the results, showing result times
                    from the base revision as well as the PR revision. This
                    page displays the speedup/slowdown by comparing the base
                    and PR revision results.
                </p>
                <div> {this.state.content} </div>
            </div>
        )
    }
}

export default function Userbenchmark() {
    return <UserbenchmarkResults/>;
}
