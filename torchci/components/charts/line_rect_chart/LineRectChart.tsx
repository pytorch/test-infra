import * as d3 from "d3";
import { TimeSeriesWrapper } from "lib/utilization/types";
import { useEffect, useRef, useState } from "react";
import { TooltipElement } from "./component/helpers/Tooltip";
import RenderLinePickerOptions from "./component/RenderLinePickerOptions";
import RenderSvgLines from "./component/RenderSvgLine";
import RenderSvgLineTooltipElements from "./component/RenderSvgLineTooltipElements";
import RenderSvgRects from "./component/RenderSvgRect";
import { D3LineRecord, Line, PickerConfig, RectangleData } from "./lib/types";
import { processLineData, processRectData, setDimensions } from "./lib/utils";
import styles from "./LineChart.module.css";

type Props = {
  onClickedRect?: (id: string) => void;
  inputLines?: TimeSeriesWrapper[];
  rects?: {
    name: string;
    start_at: string;
    end_at: string;
    color?: string;
    opacity?: number;
  }[];
  chartWidth?: number;
  disableRect?: boolean;
  disableLineTooltip?: boolean;
  selectedLineId?: string;
  lineFilterConfig?: PickerConfig[];
};

const LineRectChart = ({
  onClickedRect = (id: string) => void {},
  inputLines,
  rects,
  chartWidth,
  disableRect = false,
  disableLineTooltip = false,
  lineFilterConfig,
}: Props) => {
  const dimensions = setDimensions(chartWidth);

  // svg element state
  const svgRef = useRef<SVGSVGElement | null>(null);
  // d3 scales state
  const [scales, setScales] = useState<{ xScale: any; yScale: any }>({
    xScale: null,
    yScale: null,
  });
  // line and rect states
  const [lines, setLines] = useState<Line[]>([]);
  const [lineConfigs, setLineConfigs] = useState<
    { name: string; id: string; hidden: boolean }[]
  >([]);
  const [rectangles, setRectangles] = useState<RectangleData[]>([]);

  // tooltip state
  const [lineTooltip, setLineTooltip] = useState<{
    visible: boolean;
    content: any;
    position: { x: number; y: number };
  }>({ visible: false, content: null, position: { x: 0, y: 0 } });
  const [rectTooltip, setRectTooltip] = useState<{
    visible: boolean;
    content: any;
    position: { x: number; y: number };
  }>({ visible: false, content: null, position: { x: 0, y: 0 } });

  useEffect(() => {
    let lineData: Line[] = [];
    if (inputLines) {
      lineData = processLineData(inputLines);
      setLines(lineData);
      setLineConfigs(
        lineData.map((line) => {
          return { name: line.name, id: line.id, hidden: false };
        })
      );
    }

    if (rects) {
      let recs = processRectData(rects);
      setRectangles(recs);
    }

    if (lineData.length > 0) {
      // set x axis for svg
      const xScale = d3
        .scaleTime()
        .domain(
          d3.extent(lineData[0].records, (d: D3LineRecord) => d.date) as [
            Date,
            Date
          ]
        )
        .range([0, dimensions.ctrWidth]);

      // Set y axis scale for svg
      const yScale = d3
        .scaleLinear()
        .domain([0, 100])
        .range([dimensions.ctrHeight, 0])
        .nice();
      setScales({ xScale, yScale });
    }
    return () => {};
  }, [inputLines, rects]);

  useEffect(() => {
    // only render svg axis when dom is ready.
    if (svgRef.current && scales.xScale && scales.yScale) {
      const container = d3.select(svgRef.current).select(".container");
      const xAxis = d3.axisBottom(scales.xScale);
      const yAxis = d3.axisLeft(scales.yScale);

      container.select(".xAxis").call(xAxis as any);
      container.select(".yAxis").call(yAxis as any);
    }
  }, [scales]);

  // handle line events
  return (
    <div className={styles.chartContainer}>
      <div>
        <svg ref={svgRef} width={dimensions.width} height={dimensions.height}>
          <g
            className="container"
            transform={`translate(${dimensions.margins}, ${dimensions.margins})`}
          >
            <g
              className="xAxis"
              transform={`translate(0,${dimensions.ctrHeight})`}
            />
            <g className="yAxis" />
            <RenderSvgLines
              scales={scales}
              lines={lines}
              lineConfigs={lineConfigs}
            />
            <RenderSvgLineTooltipElements
              lines={lines}
              lineConfigs={lineConfigs}
              dimensions={dimensions}
              scales={scales}
              container={d3.select(svgRef.current).select(".container")}
              disableLineTooltip={disableLineTooltip}
              setLineTooltip={setLineTooltip}
            />
            <RenderSvgRects
              onClickedRect={onClickedRect}
              setRectTooltip={setRectTooltip}
              rectangles={rectangles}
              disableRect={disableRect}
              dimensions={dimensions}
              scales={scales}
            />
          </g>
        </svg>
        <TooltipElement
          isVisible={lineTooltip.visible}
          content={lineTooltip.content}
          position={lineTooltip.position}
        />
        <TooltipElement
          isVisible={rectTooltip.visible}
          content={rectTooltip.content}
          position={rectTooltip.position}
        />
      </div>
      {lineFilterConfig && (
        <RenderLinePickerOptions
          lines={lineConfigs}
          setLines={setLineConfigs}
          lineFilterConfig={lineFilterConfig}
        />
      )}
    </div>
  );
};

export default LineRectChart;
