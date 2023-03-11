import dayjs, { Dayjs } from "dayjs";
import ReactECharts from "echarts-for-react";
import { EChartsOption } from "echarts";
import useSWR from "swr";
import _ from "lodash";
import {
  FormControl,
  Grid,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  SelectChangeEvent,
  Skeleton,
  Stack,
  Typography,
} from "@mui/material";
import { GridValueFormatterParams } from "@mui/x-data-grid";
import React from "react";
import { useCallback, useRef, useState } from "react";
import { RocksetParam } from "lib/rockset";
import { fetcher } from "lib/GeneralUtils";
import {
  Granularity,
  TimeSeriesPanelWithData,
  seriesWithInterpolatedTimes,
} from "components/metrics/panels/TimeSeriesPanel";
import { TablePanelWithData } from "components/metrics/panels/TablePanel";
import { TimeRangePicker } from "../metrics";
import { CompilerPerformanceData } from "lib/types";

const LAST_WEEK = 7;
const ROW_HEIGHT = 245;
const ROW_GAP = 30;

const COMPILERS = ["eager", "aot_eager", "inductor", "inductor_no_cudagraphs"];
const SUITES: { [k: string]: string } = {
  torchbench: "Torchbench",
  huggingface: "Huggingface",
  timm_models: "TIMM models",
};

function GranularityPicker({
  granularity,
  setGranularity,
}: {
  granularity: string;
  setGranularity: any;
}) {
  function handleChange(e: SelectChangeEvent<string>) {
    setGranularity(e.target.value);
  }
  return (
    <FormControl>
      <InputLabel id="granularity-select-label">Granularity</InputLabel>
      <Select
        value={granularity}
        label="Granularity"
        labelId="granularity-select-label"
        onChange={handleChange}
      >
        <MenuItem value={"month"}>month</MenuItem>
        <MenuItem value={"week"}>week</MenuItem>
        <MenuItem value={"day"}>day</MenuItem>
      </Select>
    </FormControl>
  );
}

function getPassModels(data: any) {
  const passModels: { [k: string]: any } = {};

  data.forEach((record: CompilerPerformanceData) => {
    const bucket = record.granularity_bucket;
    const workflowId = record.workflow_id;
    const suite = record.suite;
    const compiler = record.compiler;
    const model = record.name;
    const accuracy = record.accuracy;

    if (!(bucket in passModels)) {
      passModels[bucket] = {};
    }

    if (!(workflowId in passModels[bucket])) {
      passModels[bucket][workflowId] = {};
    }

    if (!(suite in passModels[bucket][workflowId])) {
      passModels[bucket][workflowId][suite] = {};
    }

    if (!(compiler in passModels[bucket][workflowId][suite])) {
      passModels[bucket][workflowId][suite][compiler] = new Set<string>();
    }

    if (accuracy === "pass" || accuracy === "pass_due_to_skip") {
      passModels[bucket][workflowId][suite][compiler].add(model);
    }
  });

  return passModels;
}

function isPass(
  bucket: string,
  workflowId: number,
  suite: string,
  compiler: string,
  model: string,
  passModels: { [k: string]: any }
) {
  return passModels[bucket][workflowId][suite][compiler].has(model);
}

function computePassrate(data: any, passModels: { [k: string]: any }) {
  const totalCount: { [k: string]: any } = {};
  const passCount: { [k: string]: any } = {};

  data.forEach((record: CompilerPerformanceData) => {
    const bucket = record.granularity_bucket;
    const workflowId = record.workflow_id;
    const suite = record.suite;
    const compiler = record.compiler;
    const model = record.name;

    if (!(bucket in totalCount)) {
      totalCount[bucket] = {};
      passCount[bucket] = {};
    }

    if (!(workflowId in totalCount[bucket])) {
      totalCount[bucket][workflowId] = {};
      passCount[bucket][workflowId] = {};
    }

    if (!(suite in totalCount[bucket][workflowId])) {
      totalCount[bucket][workflowId][suite] = {};
      passCount[bucket][workflowId][suite] = {};
    }

    if (!(compiler in totalCount[bucket][workflowId][suite])) {
      totalCount[bucket][workflowId][suite][compiler] = 0;
      passCount[bucket][workflowId][suite][compiler] = 0;
    }

    if (isPass(bucket, workflowId, suite, compiler, model, passModels)) {
      passCount[bucket][workflowId][suite][compiler] += 1;
    }

    totalCount[bucket][workflowId][suite][compiler] += 1;
  });

  const passrateBySuite: { [k: string]: any } = {};

  Object.keys(totalCount).forEach((bucket: string) => {
    Object.keys(totalCount[bucket]).forEach((workflowId: string) => {
      Object.keys(totalCount[bucket][workflowId]).forEach((suite: string) => {
        Object.keys(totalCount[bucket][workflowId][suite]).forEach(
          (compiler: string) => {
            const pc = passCount[bucket][workflowId][suite][compiler];
            const tc = totalCount[bucket][workflowId][suite][compiler];
            const p = pc / tc;

            if (!(suite in passrateBySuite)) {
              passrateBySuite[suite] = [];
            }

            passrateBySuite[suite].push({
              granularity_bucket: bucket,
              suite: suite,
              compiler: compiler,
              passrate: p,
              pass_count: pc,
              total_count: tc,
              passrate_display: `${(p * 100).toFixed(0)}%, ${pc}/${tc}`,
            });
          }
        );
      });
    });
  });

  return passrateBySuite;
}

function geomean(data: number[]) {
  if (data.length === 0) {
    return 0.0;
  }

  var gm = 1.0;
  data.forEach((v) => {
    gm *= v;
  });
  return Math.pow(gm, 1.0 / data.length).toFixed(2);
}

function computeGeomean(data: any, passModels: { [k: string]: any }) {
  const speedup: { [k: string]: any } = {};

  data.forEach((record: CompilerPerformanceData) => {
    const bucket = record.granularity_bucket;
    const workflowId = record.workflow_id;
    const suite = record.suite;
    const compiler = record.compiler;
    const model = record.name;

    if (!(bucket in speedup)) {
      speedup[bucket] = {};
    }

    if (!(workflowId in speedup[bucket])) {
      speedup[bucket][workflowId] = {};
    }

    if (!(suite in speedup[bucket][workflowId])) {
      speedup[bucket][workflowId][suite] = {};
    }

    if (!(compiler in speedup[bucket][workflowId][suite])) {
      speedup[bucket][workflowId][suite][compiler] = [];
    }

    if (
      isPass(bucket, workflowId, suite, compiler, model, passModels) &&
      record.speedup !== 0.0
    ) {
      speedup[bucket][workflowId][suite][compiler].push(record.speedup);
    }
  });

  const geomeanBySuite: { [k: string]: any } = {};

  Object.keys(speedup).forEach((bucket: string) => {
    Object.keys(speedup[bucket]).forEach((workflowId: string) => {
      Object.keys(speedup[bucket][workflowId]).forEach((suite: string) => {
        Object.keys(speedup[bucket][workflowId][suite]).forEach(
          (compiler: string) => {
            const gm = geomean(speedup[bucket][workflowId][suite][compiler]);

            if (!(suite in geomeanBySuite)) {
              geomeanBySuite[suite] = [];
            }

            geomeanBySuite[suite].push({
              granularity_bucket: bucket,
              suite: suite,
              compiler: compiler,
              geomean: gm,
            });
          }
        );
      });
    });
  });

  return geomeanBySuite;
}

function computeCompilationTime(data: any, passModels: { [k: string]: any }) {
  const compTime: { [k: string]: any } = {};

  data.forEach((record: CompilerPerformanceData) => {
    const bucket = record.granularity_bucket;
    const workflowId = record.workflow_id;
    const suite = record.suite;
    const compiler = record.compiler;
    const model = record.name;
    const compLatency = record.compilation_latency;

    if (!(bucket in compTime)) {
      compTime[bucket] = {};
    }

    if (!(workflowId in compTime[bucket])) {
      compTime[bucket][workflowId] = {};
    }

    if (!(suite in compTime[bucket][workflowId])) {
      compTime[bucket][workflowId][suite] = {};
    }

    if (!(compiler in compTime[bucket][workflowId][suite])) {
      compTime[bucket][workflowId][suite][compiler] = [];
    }

    if (
      isPass(bucket, workflowId, suite, compiler, model, passModels) &&
      compLatency !== 0.0
    ) {
      compTime[bucket][workflowId][suite][compiler].push(compLatency);
    }
  });

  const compTimeBySuite: { [k: string]: any } = {};

  Object.keys(compTime).forEach((bucket: string) => {
    Object.keys(compTime[bucket]).forEach((workflowId: string) => {
      Object.keys(compTime[bucket][workflowId]).forEach((suite: string) => {
        Object.keys(compTime[bucket][workflowId][suite]).forEach(
          (compiler: string) => {
            const l = compTime[bucket][workflowId][suite][compiler].length;
            const m =
              compTime[bucket][workflowId][suite][compiler].reduce(
                (total: number, v: number) => total + v,
                0
              ) / l;

            if (!(suite in compTimeBySuite)) {
              compTimeBySuite[suite] = [];
            }

            compTimeBySuite[suite].push({
              granularity_bucket: bucket,
              suite: suite,
              compiler: compiler,
              compilation_latency: m.toFixed(2),
            });
          }
        );
      });
    });
  });

  return compTimeBySuite;
}

function computeMemoryCompressionRatio(
  data: any,
  passModels: { [k: string]: any }
) {
  const memory: { [k: string]: any } = {};

  data.forEach((record: CompilerPerformanceData) => {
    const bucket = record.granularity_bucket;
    const workflowId = record.workflow_id;
    const suite = record.suite;
    const compiler = record.compiler;
    const model = record.name;
    const compRatio = record.compression_ratio;

    if (!(bucket in memory)) {
      memory[bucket] = {};
    }

    if (!(workflowId in memory[bucket])) {
      memory[bucket][workflowId] = {};
    }

    if (!(suite in memory[bucket][workflowId])) {
      memory[bucket][workflowId][suite] = {};
    }

    if (!(compiler in memory[bucket][workflowId][suite])) {
      memory[bucket][workflowId][suite][compiler] = [];
    }

    if (
      isPass(bucket, workflowId, suite, compiler, model, passModels) &&
      compRatio !== 0.0
    ) {
      memory[bucket][workflowId][suite][compiler].push(compRatio);
    }
  });

  const memoryBySuite: { [k: string]: any } = {};

  Object.keys(memory).forEach((bucket: string) => {
    Object.keys(memory[bucket]).forEach((workflowId: string) => {
      Object.keys(memory[bucket][workflowId]).forEach((suite: string) => {
        Object.keys(memory[bucket][workflowId][suite]).forEach(
          (compiler: string) => {
            const l = memory[bucket][workflowId][suite][compiler].length;
            const m =
              memory[bucket][workflowId][suite][compiler].reduce(
                (total: number, v: number) => total + v,
                0
              ) / l;

            if (!(suite in memoryBySuite)) {
              memoryBySuite[suite] = [];
            }

            memoryBySuite[suite].push({
              granularity_bucket: bucket,
              suite: suite,
              compiler: compiler,
              compression_ratio: m.toFixed(2),
            });
          }
        );
      });
    });
  });

  return memoryBySuite;
}

function getLatestRecordByCompiler(
  dataBySuite: { [k: string]: any },
  dataFieldName: string
): [{ [k: string]: any }, string] {
  const timeFieldName = "granularity_bucket";

  const lastestRecordByCompiler: { [k: string]: any } = {};
  let latestBucket: string = "";

  Object.keys(dataBySuite).forEach((k) => {
    const buckets = dataBySuite[k].map((v: any) => v[timeFieldName]).sort();
    latestBucket = buckets[buckets.length - 1];

    dataBySuite[k].forEach((r: any) => {
      const compiler = r["compiler"];
      if (!(compiler in lastestRecordByCompiler)) {
        lastestRecordByCompiler[compiler] = {
          compiler: compiler,
        };
      }

      if (r[timeFieldName] === latestBucket) {
        const suite = r["suite"];
        lastestRecordByCompiler[compiler][suite] = r[dataFieldName];
      }
    });
  });

  return [lastestRecordByCompiler, latestBucket];
}

function SummaryPanel({
  passrateBySuite,
  geomeanBySuite,
  compTimeBySuite,
  memoryBySuite,
}: {
  passrateBySuite: { [k: string]: any };
  geomeanBySuite: { [k: string]: any };
  compTimeBySuite: { [k: string]: any };
  memoryBySuite: { [k: string]: any };
}) {
  const [lastestPassrateByCompiler, latestPassrateBucket] =
    getLatestRecordByCompiler(passrateBySuite, "passrate_display");
  const [lastestGeomeanByCompiler, latestGeomeanBucket] =
    getLatestRecordByCompiler(geomeanBySuite, "geomean");
  const [lastestCompTimeByCompiler, latestCompTimeBucket] =
    getLatestRecordByCompiler(compTimeBySuite, "compilation_latency");
  const [lastestMemoryByCompiler, latestMemoryBucket] =
    getLatestRecordByCompiler(memoryBySuite, "compression_ratio");

  const columns = [
    {
      field: "compiler",
      headerName: "Compiler",
      flex: 1,
    },
  ];

  return (
    <Grid container spacing={2} height={ROW_HEIGHT + ROW_GAP}>
      <Grid item xs={12} lg={3}>
        <TablePanelWithData
          title={`Passrate - ${dayjs(latestPassrateBucket).format(
            "YYYY/MM/DD"
          )}`}
          data={Object.values(lastestPassrateByCompiler).sort(
            (a: any, b: any) => a["compiler"].localeCompare(b["compiler"])
          )}
          columns={columns.concat(
            Object.keys(SUITES).map((suite: string) => {
              return {
                field: suite,
                headerName: SUITES[suite],
                flex: 1,
              };
            })
          )}
          dataGridProps={{ getRowId: (el: any) => el.suite + el.compiler }}
        />
      </Grid>

      <Grid item xs={12} lg={3}>
        <TablePanelWithData
          title={`Geometric mean speedup - ${dayjs(latestGeomeanBucket).format(
            "YYYY/MM/DD"
          )}`}
          data={Object.values(lastestGeomeanByCompiler).sort((a: any, b: any) =>
            a["compiler"].localeCompare(b["compiler"])
          )}
          columns={columns.concat(
            Object.keys(SUITES).map((suite: string) => {
              return {
                field: suite,
                headerName: SUITES[suite],
                flex: 1,
                valueFormatter: (params: GridValueFormatterParams<any>) => {
                  return `${Number(params.value).toFixed(2)}x`;
                },
              };
            })
          )}
          dataGridProps={{ getRowId: (el: any) => el.suite + el.compiler }}
        />
      </Grid>

      <Grid item xs={12} lg={3}>
        <TablePanelWithData
          title={`Mean compilation time (seconds) - ${dayjs(
            latestCompTimeBucket
          ).format("YYYY/MM/DD")}`}
          data={Object.values(lastestCompTimeByCompiler).sort(
            (a: any, b: any) => a["compiler"].localeCompare(b["compiler"])
          )}
          columns={columns.concat(
            Object.keys(SUITES).map((suite: string) => {
              return {
                field: suite,
                headerName: SUITES[suite],
                flex: 1,
                valueFormatter: (params: GridValueFormatterParams<any>) => {
                  return `${Number(params.value).toFixed(2)}s`;
                },
              };
            })
          )}
          dataGridProps={{ getRowId: (el: any) => el.suite + el.compiler }}
        />
      </Grid>

      <Grid item xs={12} lg={3}>
        <TablePanelWithData
          title={`Peak memory footprint compression ratio (higher is better) - ${dayjs(
            latestMemoryBucket
          ).format("YYYY/MM/DD")}`}
          data={Object.values(lastestMemoryByCompiler).sort((a: any, b: any) =>
            a["compiler"].localeCompare(b["compiler"])
          )}
          columns={columns.concat(
            Object.keys(SUITES).map((suite: string) => {
              return {
                field: suite,
                headerName: SUITES[suite],
                flex: 1,
                valueFormatter: (params: GridValueFormatterParams<any>) => {
                  return `${Number(params.value).toFixed(2)}x`;
                },
              };
            })
          )}
          dataGridProps={{ getRowId: (el: any) => el.suite + el.compiler }}
        />
      </Grid>
    </Grid>
  );
}

function generateChartSeries(
  dataBySuite: { [k: string]: any },
  dataFieldName: string,
  groupByFieldName: string,
  startTime: Dayjs,
  stopTime: Dayjs,
  granularity: Granularity
) {
  const timeFieldName = "granularity_bucket";

  const chartSeries: { [k: string]: any } = {};
  Object.keys(dataBySuite).forEach((key) => {
    chartSeries[key] = seriesWithInterpolatedTimes(
      dataBySuite[key],
      startTime,
      stopTime,
      granularity,
      groupByFieldName,
      timeFieldName,
      dataFieldName
    );
  });

  return chartSeries;
}

function PerformanceGraphs({
  passrateBySuite,
  geomeanBySuite,
  compTimeBySuite,
  memoryBySuite,
  startTime,
  stopTime,
  granularity,
}: {
  passrateBySuite: { [k: string]: any };
  geomeanBySuite: { [k: string]: any };
  compTimeBySuite: { [k: string]: any };
  memoryBySuite: { [k: string]: any };
  startTime: Dayjs;
  stopTime: Dayjs;
  granularity: Granularity;
}) {
  const groupByFieldName = "compiler";

  const passrateSeries = generateChartSeries(
    passrateBySuite,
    "passrate",
    groupByFieldName,
    startTime,
    stopTime,
    granularity
  );
  const geomeanSeries = generateChartSeries(
    geomeanBySuite,
    "geomean",
    groupByFieldName,
    startTime,
    stopTime,
    granularity
  );
  const compTimeSeries = generateChartSeries(
    compTimeBySuite,
    "compilation_latency",
    groupByFieldName,
    startTime,
    stopTime,
    granularity
  );
  const memorySeries = generateChartSeries(
    memoryBySuite,
    "compression_ratio",
    groupByFieldName,
    startTime,
    stopTime,
    granularity
  );

  return (
    <Grid container spacing={2}>
      {Object.keys(SUITES).map((suite: string) => (
        <Grid item xs={12} lg={4} height={ROW_HEIGHT} key={suite}>
          <TimeSeriesPanelWithData
            data={passrateBySuite[suite]}
            series={passrateSeries[suite]}
            title={`Passrate / ${SUITES[suite]}`}
            yAxisLabel={"%"}
            groupByFieldName={groupByFieldName}
            yAxisRenderer={(unit) => {
              return `${(unit * 100).toFixed(0)} %`;
            }}
            additionalOptions={{
              yAxis: {
                min: 0.6,
                max: 1.0,
              },
            }}
          />
        </Grid>
      ))}

      {Object.keys(SUITES).map((suite: string) => (
        <Grid item xs={12} lg={4} height={ROW_HEIGHT} key={suite}>
          <TimeSeriesPanelWithData
            data={geomeanBySuite[suite]}
            series={geomeanSeries[suite]}
            title={`Geomean / ${SUITES[suite]}`}
            groupByFieldName={groupByFieldName}
            yAxisRenderer={(unit) => {
              return `${unit}`;
            }}
          />
        </Grid>
      ))}

      {Object.keys(SUITES).map((suite: string) => (
        <Grid item xs={12} lg={4} height={ROW_HEIGHT} key={suite}>
          <TimeSeriesPanelWithData
            data={compTimeBySuite[suite]}
            series={compTimeSeries[suite]}
            title={`Mean compilation time / ${SUITES[suite]}`}
            groupByFieldName={groupByFieldName}
            yAxisLabel={"second"}
            yAxisRenderer={(unit) => {
              return `${unit}`;
            }}
          />
        </Grid>
      ))}

      {Object.keys(SUITES).map((suite: string) => (
        <Grid item xs={12} lg={4} height={ROW_HEIGHT} key={suite}>
          <TimeSeriesPanelWithData
            data={memoryBySuite[suite]}
            series={memorySeries[suite]}
            title={`Peak memory footprint compression ratio / ${SUITES[suite]}`}
            groupByFieldName={groupByFieldName}
            yAxisRenderer={(unit) => {
              return `${unit}`;
            }}
          />
        </Grid>
      ))}
    </Grid>
  );
}

function Report({
  queryParams,
  granularity,
}: {
  queryParams: RocksetParam[];
  granularity: Granularity;
}) {
  const queryName = "compilers_benchmark_performance";
  const queryCollection = "inductor";

  const url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;
  const { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  if (error !== undefined) {
    return (
      <div>
        An error occurred while fetching data, perhaps there are too many
        results with your choice of time range and granularity?
      </div>
    );
  }
  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  // Clamp to the nearest granularity (e.g. nearest hour) so that the times will
  // align with the data we get from Rockset
  const startTime = dayjs(
    queryParams.find((p) => p.name === "startTime")?.value
  ).startOf(granularity);
  const stopTime = dayjs(
    queryParams.find((p) => p.name === "stopTime")?.value
  ).startOf(granularity);

  const passModels = getPassModels(data);
  const passrateBySuite = computePassrate(data, passModels);
  const geomeanBySuite = computeGeomean(data, passModels);
  const compTimeBySuite = computeCompilationTime(data, passModels);
  const memoryBySuite = computeMemoryCompressionRatio(data, passModels);

  return (
    <div>
      <SummaryPanel
        passrateBySuite={passrateBySuite}
        geomeanBySuite={geomeanBySuite}
        compTimeBySuite={compTimeBySuite}
        memoryBySuite={memoryBySuite}
      />
      <PerformanceGraphs
        passrateBySuite={passrateBySuite}
        geomeanBySuite={geomeanBySuite}
        compTimeBySuite={compTimeBySuite}
        memoryBySuite={memoryBySuite}
        startTime={startTime}
        stopTime={stopTime}
        granularity={granularity}
      />
    </div>
  );
}

export default function Page() {
  const [startTime, setStartTime] = useState(dayjs().subtract(1, "week"));
  const [stopTime, setStopTime] = useState(dayjs());
  const [granularity, setGranularity] = useState<Granularity>("day");

  const queryParams: RocksetParam[] = [
    {
      name: "timezone",
      type: "string",
      value: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    {
      name: "startTime",
      type: "string",
      value: startTime,
    },
    {
      name: "stopTime",
      type: "string",
      value: stopTime,
    },
    {
      name: "granularity",
      type: "string",
      value: granularity,
    },
    {
      name: "dtypes",
      type: "string",
      value: "amp",
    },
  ];

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          TorchDynamo Performance DashBoard
        </Typography>
        <TimeRangePicker
          startTime={startTime}
          stopTime={stopTime}
          setStartTime={setStartTime}
          setStopTime={setStopTime}
          defaultValue={LAST_WEEK}
        />
        <GranularityPicker
          granularity={granularity}
          setGranularity={setGranularity}
        />
      </Stack>

      <Grid item xs={6}>
        <Report queryParams={queryParams} granularity={granularity} />
      </Grid>
    </div>
  );
}
