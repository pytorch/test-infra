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
  renderOptions?: any;
  defaultSelectMode?: boolean;
  /** Called when user clicks Confirm with L/R selected for a single series. */
  onConfirm?: (sel: ConfirmPayload) => void;
};
const BenchmarkTimeSeriesChart: React.FC<Props> = ({
  timeseries,
  renderOptions,
  defaultSelectMode = false,
  onConfirm = () => {},
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

  const globalExtents = useMemo(() => {
    let minX = Infinity,
      maxX = -Infinity;
    let minY = Infinity,
      maxY = -Infinity;
    for (const d of seriesDatas) {
      for (const p of d) {
        const x = p.value[0] as number;
        const y = p.value[1] as number;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    const padY = Math.max((maxY - minY) * 0.05, 1e-6); // 给点余量，避免顶边
    return {
      minX,
      maxX,
      minY: minY - padY,
      maxY: maxY + padY,
    };
  }, [seriesDatas]);

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
        name: data[idx]?.legend_name ?? `Series ${idx + 1}`,
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

  const option: echarts.EChartsOption = useMemo(() => {
    return {
      ...echartRenderingOptions,
      xAxis: {
        ...(echartRenderingOptions as any).xAxis,
        min: globalExtents.minX,
        max: globalExtents.maxX,
      },
      yAxis: {
        ...(echartRenderingOptions as any).yAxis,
        min: globalExtents.minY,
        max: globalExtents.maxY,
        // 可选：避免自动吸0
        scale: true,
      },
      series: [...lineSeries, ...overlaySeries],
    };
  }, [lineSeries, overlaySeries]);

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

  function confirm() {
    if (!hasBoth) return;
    onConfirm({
      seriesIndex: selectedSeriesIdx!,
      seriesName: currentSeriesName!,
      groupInfo: currentGroupInfo || {},
      left: leftMeta!,
      right: rightMeta!,
    });
  }

  return (
    <Box sx={{ width: "100%", height: renderOptions?.height ?? 300 }}>
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
        onConfirm={confirm}
        confirmDisabled={!hasBoth}
        clearDisabled={!leftMeta && !rightMeta}
      />
      {/* Echart controls */}
      <ReactECharts
        ref={chartRef}
        echarts={echarts}
        option={option}
        notMerge={true}
        lazyUpdate
        onEvents={onEvents}
        style={{ width: "100%", height: renderOptions?.height ?? "200px" }}
      />
    </Box>
  );
};
export default BenchmarkTimeSeriesChart;
