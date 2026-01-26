import { Box } from "@mui/material";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import * as echarts from "echarts";
import ReactECharts from "echarts-for-react";
import React, { useMemo, useRef, useState } from "react";
import {
  BenchmarkTimeSeriesCharRenderOpiton,
  BenchmarkTimeSeriesInput,
  fmtFixed2,
  getBenchmarkTimeSeriesChartRenderingConfig,
  getSmartValue,
  RawTimeSeriesPoint,
  renderBasedOnUnitConifg,
} from "../../helper";
import {
  ChartLineSelectDialog,
  ChartLineSelectionDialogComponent,
} from "./ChartLineSelectionControl";
import { echartRenderingOptions } from "./RenderingOptions";
import { toEchartTimeSeriesData } from "./type";

dayjs.extend(utc);

type ConfirmPayload = {
  seriesIndex: number;
  seriesName: string;
  groupInfo: Record<string, string | number>;
};

type Props = {
  timeseries: BenchmarkTimeSeriesInput[];
  customizedDialog?: { config: any; comp: ChartLineSelectionDialogComponent };
  renderOptions?: BenchmarkTimeSeriesCharRenderOpiton;
  markArea?: {
    start?: string;
    end?: string;
    singleGap?: number;
  };
  enableSelectLine?: boolean;
  legendKeys?: string[];
  /** Called when user clicks Confirm with L/R selected for a single series. */
  onSelect?: (sel: ConfirmPayload) => void;
};

const DEFAULT_HEIGHT = 200;
const NORMAL_DOT_SIZE = 4;

const BenchmarkTimeLineSelectSeriesChart: React.FC<Props> = ({
  timeseries,
  renderOptions,
  customizedDialog,
  legendKeys,
  enableSelectLine = false,
  onSelect = () => {},
}) => {
  const chartRef = useRef<ReactECharts>(null);

  // Selection state
  const [selectedSeriesIdx, setSelectedSeriesIdx] = useState<number | null>(
    null
  );
  const seriesDatas = useMemo(
    () => timeseries.map((s) => toEchartTimeSeriesData(s)),
    [timeseries]
  );
  const tooltipFormatter: NonNullable<
    echarts.TooltipComponentOption["formatter"]
  > = ((raw: unknown) => {
    const p = Array.isArray(raw) ? raw[0] : (raw as any);
    const meta = p?.data?.meta as RawTimeSeriesPoint | undefined;
    if (!meta) return "";

    const t = dayjs
      .utc(meta.granularity_bucket)
      .format("YYYY-MM-DD HH:mm [UTC]");
    const pct = fmtFixed2(meta.value);
    const commitShort = meta.commit.slice(0, 7);
    const rc = getBenchmarkTimeSeriesChartRenderingConfig(
      meta.metric,
      renderOptions
    );

    let value = pct;
    let displayName = meta.metric;
    if (rc) {
      value = renderBasedOnUnitConifg(value, rc?.unit);
      displayName = rc?.displayName ?? meta.metric;
    }

    let legendKeyItems: string[] = [];
    if (renderOptions?.showLegendDetails) {
      legendKeys?.forEach((k) => {
        const v = getSmartValue(meta, k);
        if (v) {
          legendKeyItems.push(
            `<div style="font-size:10px;"><i>${k}:${v}</i></div>`
          );
        }
      });
      if (legendKeyItems.length > 0) {
        const legendItemTitle = `<div style="margin-top:4px;"><i>Metadata:</i></div>`;
        legendKeyItems = [legendItemTitle, ...legendKeyItems];
      }
    }

    return [
      `<div style="font-weight:600;margin-bottom:4px;">${t}</div>`,
      `<div style="
          font-size:12px;
          max-width:240px;
          white-space: normal;
          word-break: break-word;
          line-height:1.4;
        ">
        <b>legend name</b>: ${p?.data?.legend_name ?? ""}
      </div>`,
      `<div><b>${displayName}</b>: <b>${value}</b></div>`,
      `<div>commit <code>${commitShort}</code> · workflow ${meta.workflow_id} · branch ${meta.branch}</div>`,
      ...legendKeyItems,
    ].join("");
  }) as any;

  function resetSelection() {
    setSelectedSeriesIdx(null);
  }

  function handleLineClick(seriesIndex: number) {
    // In line-select mode, treat any click on the line as selecting that series
    setSelectedSeriesIdx(seriesIndex); // or a separate state if you don’t want to reuse
    // resetPointSelection(); // uncomment if you want to clear L/R when selecting a line
  }

  // Build line series first (indices 0..N-1 map to logical timeseries)
  const lineSeries: echarts.SeriesOption[] = useMemo(() => {
    let ma: any = [];

    const lines = seriesDatas.map((data, idx) => {
      const mlData: any[] = [];

      return {
        name: timeseries[idx]?.legend_name ?? `Series ${idx + 1}`,
        type: "line",
        showSymbol: true,
        symbolSize: (_: any, params: any) => {
          const s = params?.data?.meta?.renderOptions?.size;
          return s ? s : NORMAL_DOT_SIZE;
        },
        data,
        silent: false,
        triggerLineEvent: enableSelectLine,
        lineStyle: {},
        itemStyle: {
          color: (params: any) => {
            const color = params?.data?.meta?.renderOptions?.color;
            return color ? color : params?.color;
          },
        },
        ...(mlData.length
          ? { markLine: { data: mlData, symbol: "none" } }
          : {}),
      } as echarts.SeriesOption;
    });
    return [...lines];
  }, [seriesDatas, timeseries, selectedSeriesIdx]);

  // Highlight overlays appended after all lines
  const overlaySeries: echarts.SeriesOption[] = useMemo(() => {
    if (selectedSeriesIdx == null) return [];
    const sel: any[] = [];
    if (!sel.length) return [];
    return [
      {
        name: `sel-${selectedSeriesIdx}`,
        type: "effectScatter",
        z: 5,
        rippleEffect: { scale: 2.1 },
        symbolSize: NORMAL_DOT_SIZE,
        data: sel,
      } as echarts.SeriesOption,
    ];
  }, [seriesDatas, selectedSeriesIdx]);

  // form the final option
  const option: echarts.EChartsOption = useMemo(() => {
    return {
      ...echartRenderingOptions,
      legend: {
        ...echartRenderingOptions.legend,
      },
      tooltip: {
        trigger: "item",
        triggerOn: "mousemove|click",
        formatter: tooltipFormatter,
      },
      series: [...lineSeries, ...overlaySeries],
    };
  }, [lineSeries, overlaySeries]);

  const onEvents = {
    click: (p: any) => {
      if (!p || p.seriesType !== "line") return;
      if (typeof p.seriesIndex !== "number") return;
      console.log("clicked:", p);
      if (enableSelectLine) {
        handleLineClick(p.seriesIndex);
        return; // 🔴 critical
      }
    },
  };
  const selectline = selectedSeriesIdx != null;
  const currentSeriesName =
    selectedSeriesIdx != null
      ? timeseries[selectedSeriesIdx].legend_name ??
        `Series ${selectedSeriesIdx + 1}`
      : null;
  const input =
    selectedSeriesIdx != null ? timeseries[selectedSeriesIdx] : null;
  return (
    <Box
      sx={{
        width: "100%",
        height: renderOptions?.height ?? `${DEFAULT_HEIGHT + 30}`,
      }}
    >
      {/* Selection controls */}
      {enableSelectLine ? (
        <ChartLineSelectDialog
          onClose={resetSelection}
          open={selectline}
          Component={customizedDialog?.comp}
          config={customizedDialog?.config}
          data={input}
        />
      ) : null}

      {/* Echart controls */}
      <ReactECharts
        ref={chartRef}
        echarts={echarts}
        option={option}
        notMerge={true}
        lazyUpdate
        onEvents={onEvents}
        style={{
          width: "100%",
          height: renderOptions?.height ?? DEFAULT_HEIGHT,
        }}
      />
    </Box>
  );
};
export default BenchmarkTimeLineSelectSeriesChart;
