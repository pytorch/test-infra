// MultiPassrateTimeSeries.tsx
import { Box } from "@mui/material";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import * as echarts from "echarts";
import ReactECharts from "echarts-for-react";
import React, { useMemo, useRef, useState } from "react";
import { BenchmarkTimeSeriesInput, RawTimeSeriesPoint } from "../../helper";
import { ChartSelectionControl } from "./ChartSelectionControl";
import { echartRenderingOptions } from "./RenderingOptions";
import { toEchartTimeSeriesData } from "./type";

dayjs.extend(utc);

type ConfirmPayload = {
  seriesIndex: number;
  seriesName: string;
  groupInfo: Record<string, string | number>;
  left: RawTimeSeriesPoint;
  right: RawTimeSeriesPoint;
};

type Props = {
  timeseries: BenchmarkTimeSeriesInput[];
  customizedConfirmDialog?: { type: string; id?: string };
  renderOptions?: {
    height?: string | number;
    lineMapping?: Record<string, any>;
  };
  defaultSelectMode?: boolean;
  /** Called when user clicks Confirm with L/R selected for a single series. */
  onSelect?: (sel: ConfirmPayload) => void;
};

const DEFAULT_HEIGHT = 200;

const BenchmarkTimeSeriesChart: React.FC<Props> = ({
  timeseries,
  renderOptions,
  customizedConfirmDialog,
  defaultSelectMode = false,
  onSelect = () => {},
}) => {
  const chartRef = useRef<ReactECharts>(null);

  // Selection state
  const [selectMode, setSelectMode] = useState<boolean>(defaultSelectMode);
  const [selectedSeriesIdx, setSelectedSeriesIdx] = useState<number | null>(
    null
  );
  const [leftIdx, setLeftIdx] = useState<number | null>(null);
  const [rightIdx, setRightIdx] = useState<number | null>(null);

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
    const pct = meta.value.toFixed(3);
    const commitShort = meta.commit.slice(0, 7);

    let value = pct;
    const rule = renderOptions?.lineMapping?.[meta.metric];
    if (rule) {
      value = renderByRule(
        rule?.type ?? "default",
        rule?.scale ? rule?.scale : 1,
        pct
      );
    }
    return [
      `<div style="font-weight:600;margin-bottom:4px;">${t}</div>`,
      `<div style="font-size:12px;">${p?.data?.legend_name}</div>`,
      `<b>${meta.metric}</b>: <b>${value}</b><br/>`,
      `commit <code>${commitShort}</code> · workflow ${meta.workflow_id} · branch ${meta.branch}`,
    ].join("");
  }) as any;

  function resetSelection() {
    setSelectedSeriesIdx(null);
    setLeftIdx(null);
    setRightIdx(null);
  }

  function handlePointClick(seriesIndex: number, dataIndex: number) {
    if (!selectMode) return;
    // Lock to a series on first click
    if (selectedSeriesIdx == null) {
      setSelectedSeriesIdx(seriesIndex);
      setLeftIdx(dataIndex);
      setRightIdx(null);
      return;
    }

    // Must stay within the locked series
    if (seriesIndex !== selectedSeriesIdx) return;

    if (leftIdx == null) {
      setLeftIdx(dataIndex);
    } else if (rightIdx == null) {
      // keep chronological order L <= R
      if (dataIndex < leftIdx) {
        setRightIdx(leftIdx);
        setLeftIdx(dataIndex);
      } else {
        setRightIdx(dataIndex);
      }
    } else {
      // replace the closer one
      const dL = Math.abs(dataIndex - leftIdx);
      const dR = Math.abs(dataIndex - rightIdx);
      if (dL <= dR) setLeftIdx(dataIndex);
      else setRightIdx(dataIndex);
    }
  }

  // Build line series first (indices 0..N-1 map to logical timeseries)
  const lineSeries: echarts.SeriesOption[] = useMemo(() => {
    return seriesDatas.map((data, idx) => {
      const isSelected = selectedSeriesIdx === idx;
      const mlData: any[] = [];

      const isOther = selectedSeriesIdx != null && !isSelected;
      const baseOpacity = selectedSeriesIdx == null ? 1 : isSelected ? 1 : 0.12;
      if (isSelected && leftIdx != null && data[leftIdx]) {
        mlData.push({
          xAxis: data[leftIdx].value[0],
          label: { formatter: "L", position: "insideEndTop" },
          lineStyle: { type: "solid", width: 2 },
        });
      }

      if (isSelected && rightIdx != null && data[rightIdx]) {
        mlData.push({
          xAxis: data[rightIdx].value[0],
          label: { formatter: "R", position: "insideEndTop" },
          lineStyle: { type: "solid", width: 2 },
        });
      }

      return {
        name: timeseries[idx]?.legend_name ?? `Series ${idx + 1}`,
        type: "line",
        showSymbol: true,
        symbolSize: 4,
        data,
        silent: !!isOther,
        lineStyle: {
          opacity: baseOpacity, // line transparency
        },
        itemStyle: {
          opacity: baseOpacity, // dot transparency
        },
        ...(mlData.length
          ? { markLine: { data: mlData, symbol: "none" } }
          : {}),
      } as echarts.SeriesOption;
    });
  }, [seriesDatas, timeseries, selectedSeriesIdx, leftIdx, rightIdx]);

  // Highlight overlays appended after all lines
  const overlaySeries: echarts.SeriesOption[] = useMemo(() => {
    if (selectedSeriesIdx == null) return [];
    const data = seriesDatas[selectedSeriesIdx] || [];
    const sel: any[] = [];
    if (leftIdx != null && data[leftIdx]) sel.push(data[leftIdx]);
    if (rightIdx != null && data[rightIdx]) sel.push(data[rightIdx]);
    if (!sel.length) return [];
    return [
      {
        name: `sel-${selectedSeriesIdx}`,
        type: "effectScatter",
        z: 5,
        rippleEffect: { scale: 2.1 },
        symbolSize: 4,
        data: sel,
      } as echarts.SeriesOption,
    ];
  }, [seriesDatas, selectedSeriesIdx, leftIdx, rightIdx]);

  const legendSelected = useMemo(() => {
    if (selectedSeriesIdx == null) return undefined;
    const m: Record<string, boolean> = {};
    timeseries.forEach((s, i) => {
      const name = s.legend_name ?? `Series ${i + 1}`;
      m[name] = i === selectedSeriesIdx;
    });
    return m;
  }, [selectedSeriesIdx, timeseries]);

  // form the final option
  const option: echarts.EChartsOption = useMemo(() => {
    return {
      ...echartRenderingOptions,
      legend: {
        ...echartRenderingOptions.legend,
        ...(legendSelected ? { selected: legendSelected } : {}),
      },
      tooltip: {
        trigger: "item",
        triggerOn: "mousemove|click",
        formatter: tooltipFormatter,
      },
      series: [...lineSeries, ...overlaySeries],
    };
  }, [lineSeries, overlaySeries, legendSelected]);

  const onEvents = {
    click: (p: any) => {
      if (!p || p.seriesType !== "line") return;
      if (typeof p.seriesIndex !== "number" || typeof p.dataIndex !== "number")
        return;
      handlePointClick(p.seriesIndex, p.dataIndex);
    },
  };

  const hasBoth =
    selectedSeriesIdx != null && leftIdx != null && rightIdx != null;
  const currentSeriesName =
    selectedSeriesIdx != null
      ? timeseries[selectedSeriesIdx].legend_name ??
        `Series ${selectedSeriesIdx + 1}`
      : null;
  const currentGroupInfo =
    selectedSeriesIdx != null ? timeseries[selectedSeriesIdx].group_info : null;

  const leftMeta =
    selectedSeriesIdx != null && leftIdx != null
      ? (seriesDatas[selectedSeriesIdx][leftIdx].meta as RawTimeSeriesPoint)
      : null;
  const rightMeta =
    selectedSeriesIdx != null && rightIdx != null
      ? (seriesDatas[selectedSeriesIdx][rightIdx].meta as RawTimeSeriesPoint)
      : null;

  function select() {
    if (!hasBoth) return;
    onSelect({
      seriesIndex: selectedSeriesIdx!,
      seriesName: currentSeriesName!,
      groupInfo: currentGroupInfo || {},
      left: leftMeta!,
      right: rightMeta!,
    });
  }

  return (
    <Box
      sx={{
        width: "100%",
        height: renderOptions?.height ?? `${DEFAULT_HEIGHT + 30}`,
      }}
    >
      {/* Selection controls */}
      <ChartSelectionControl
        selectMode={selectMode}
        setSelectMode={(v) => {
          setSelectMode(v);
          if (!v) resetSelection();
        }}
        leftMeta={leftMeta}
        rightMeta={rightMeta}
        onClear={resetSelection}
        onSelect={select}
        confirmDisabled={!hasBoth}
        clearDisabled={!leftMeta && !rightMeta}
        customizedConfirmDialog={customizedConfirmDialog}
      />
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
export default BenchmarkTimeSeriesChart;

function renderByRule(rule: string, scale: number, data: any) {
  switch (rule) {
    case "percent":
      return `${(data * scale).toFixed(2)}%`;
    default:
      return data;
  }
}
