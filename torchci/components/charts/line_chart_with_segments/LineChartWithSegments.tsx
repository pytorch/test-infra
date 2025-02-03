import * as d3 from "d3";
import { Dispatch, SetStateAction, useEffect, useRef, useState } from "react";
import { TooltipElement } from "./component/helpers/Tooltip";
import RenderLinePickerOptions from "./component/RenderLinePickerOptions";
import {
  RenderIndicatorLine,
  RenderLineTooltipContent,
  RenderSegmentTooltipContent,
  RenderTooltipCircles,
} from "./component/RenderTooltips";
import { getRandomColor } from "./d3_chart_utils/color";
import { D3LineRecord, Line, RectangleData } from "./d3_chart_utils/types";
import {
  getRecordyDate,
  PickerConfig,
  processLineData,
  processRectData,
  setDimensions,
} from "./d3_chart_utils/utils";
import styles from "./LineChart.module.css";

type Props = {
  onDataChange?: (data: any) => void;
  inputLines: {
    name: string;
    records: { ts: string; value: number }[];
    color?: string;
  }[];
  segments: {
    name: string;
    start_at: string;
    end_at: string;
    color?: string;
  }[];
  chartWidth?: number;
  disableSegment?: boolean;
  disableLineTooltip?: boolean;
  selectedLineId?: string;
  linePickerConfig?: Map<string, PickerConfig>;
};

const LineChartWithSegments = ({
  onDataChange = (data: any) => void {},
  inputLines,
  segments = [],
  chartWidth = 2000,
  disableSegment = false,
  disableLineTooltip = false,
  linePickerConfig = new Map<string, PickerConfig>(),
}: Props) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dimensions = setDimensions(chartWidth);
  const [lines, setLines] = useState<Line[]>([]);
  const [rectangles, setRectangles] = useState<RectangleData[]>([]);
  const [lineTooltip, setLineTooltip] = useState<{
    visible: boolean;
    content: any;
    position: { x: number; y: number };
  }>({ visible: false, content: null, position: { x: 0, y: 0 } });
  const [segTooltip, setSegTooltip] = useState<{
    visible: boolean;
    content: any;
    position: { x: number; y: number };
  }>({ visible: false, content: null, position: { x: 0, y: 0 } });

  const [scales, setScales] = useState<{ xScale: any; yScale: any }>({
    xScale: null,
    yScale: null,
  });
  const [lineCategory, setLineCategory] = useState<string>("");

  const lineGenerator = d3
    .line<D3LineRecord>()
    .x((d: D3LineRecord) => scales.xScale(d.date))
    .y((d: D3LineRecord) => scales.yScale(d.value));

  useEffect(() => {
    if (inputLines.length == 0) {
      setLines([]);
      return;
    }
    const lineData = processLineData(inputLines);
    let recs = processRectData(segments);
    setLines(lineData);
    setRectangles(recs);
    // set x axis
    const xScale = d3
      .scaleTime()
      .domain(
        d3.extent(lineData[0].records, (d: D3LineRecord) => d.date) as [
          Date,
          Date
        ]
      )
      .range([0, dimensions.ctrWidth]);

    // Set y axis scale
    const yScale = d3
      .scaleLinear()
      .domain([0, 100])
      .range([dimensions.ctrHeight, 0])
      .nice();
    setScales({ xScale, yScale });

    return () => {};
  }, [inputLines, segments]);

  useEffect(() => {
    // only render svg axis when dom is ready.
    if (svgRef.current && scales.xScale && scales.yScale) {
      const container = d3.select(svgRef.current).select(".container");
      container.select(".xAxis").call(d3.axisBottom(scales.xScale));
      container.select(".yAxis").call(d3.axisLeft(scales.yScale));
    }
  }, [scales.xScale, scales.yScale]);

  // handle line events
  const handleLineMouseMove = (event: React.MouseEvent) => {
    if (disableLineTooltip) {
      return;
    }
    d3HandleMouseMovement(
      lines,
      dimensions,
      scales.xScale,
      scales.yScale,
      event
    );
  };

  const handleLineMouseLeave = (event: React.MouseEvent) => {
    const container = d3.select(svgRef.current).select(".container");
    const verticalLine = container.select(".indicator-line");

    // when mouse leaves the line area, hide the indicator, circles and tooltip.
    verticalLine.attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 0);
    container.selectAll(".tooltip-circle").style("opacity", 0);
    setLineTooltip({ visible: false, content: null, position: { x: 0, y: 0 } });
  };

  // helper function to using d3 to manage element in chart for line events.
  // bisect the date to get the closest data point to the mouse position,
  // then update the indicator line, circles and tooltip based on the data point.
  function d3HandleMouseMovement(
    lineList: Line[],
    dimensions: any,
    xScale: any,
    yScale: any,
    event: { pageX: number; pageY: number }
  ) {
    if (lineList.length == 0) {
      return;
    }

    // Get the mouse position relative to the Xscale date range.
    const mousePos = d3.pointer(event, d3.this);
    const date = xScale.invert(mousePos[0]);

    // Get the closest data point to the mouse position
    const hoveredData = getRecordyDate(lineList[0].records, date);
    if (hoveredData == undefined) {
      console.log("No data from records found for date", date);
      return;
    }

    let lineDataMap = new Map<string, D3LineRecord>();
    for (const line of lineList) {
      if (line.hidden) {
        continue;
      }
      const res = getRecordyDate(line.records, date);
      lineDataMap.set(line.name, res);
    }
    if (lineDataMap.size == 0) {
      return;
    }

    // update tooltip, indicator line and circles based on mouse movement in chart.
    const container = d3.select(svgRef.current).select(".container");
    RenderIndicatorLine(container, xScale, hoveredData, dimensions.ctrHeight);
    RenderTooltipCircles(container, xScale, yScale, lineDataMap);
    setLineTooltip({
      visible: true,
      content: RenderLineTooltipContent(
        hoveredData.date,
        lineList,
        lineDataMap
      ),
      position: { x: event.pageX, y: event.pageY },
    });
  }


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
            <g className="lines-group">
              {lines.map((line, i) => {
                return (
                  <path
                    key={i}
                    d={lineGenerator(line.records)}
                    id={line.name + "-line"}
                    className={"line"}
                    fill="none"
                    opacity={line.hidden ? 0.1 : 1}
                    stroke={line.color ? line.color : getRandomColor(i)}
                    strokeWidth={2}
                  />
                );
              })}
            </g>
            <line
              className="indicator-line"
              stroke="steelblue"
              strokeWidth={2}
              strokeDasharray={5.5}
            />
            {lines.map((line, i) => {
              return (
                <circle
                  key={i}
                  r={5}
                  id={line.name}
                  className="tooltip-circle"
                  fill="#fc8781"
                  stroke="black"
                  strokeWidth={1.5}
                  strokeOpacity={0.4}
                  opacity={0}
                  style={{ pointerEvents: "none" }}
                />
              );
            })}
            <rect
              className="overlay"
              width={dimensions.ctrWidth}
              height={dimensions.ctrHeight}
              fillOpacity={0}
              onMouseMove={handleLineMouseMove}
              onMouseLeave={handleLineMouseLeave}
            />
            <RenderSvgSegment
              setSegTooltip={setSegTooltip}
              rectangles={rectangles}
              disableSegment={disableSegment}
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
          isVisible={segTooltip.visible}
          content={segTooltip.content}
          position={segTooltip.position}
        />
      </div>
      <RenderLinePickerOptions
        lines={lines}
        setLines={setLines}
        lineCategory={lineCategory}
        setLineCategory={setLineCategory}
        linePickerConfig={linePickerConfig}
      />
    </div>
  );
};

export default LineChartWithSegments;


const RenderSvgSegment = (
  {
    setSegTooltip,
    rectangles,
    disableSegment,
    dimensions,
    scales,
  }:{
  setSegTooltip:Dispatch<SetStateAction<{
    visible: boolean;
    content: any;
    position: {
        x: number;
        y: number;
    };
  }>>,
  rectangles: RectangleData[],
  disableSegment?: boolean,
  dimensions: any,
  scales: any,
 })=>{
   // helper function to get the width of a rectangle, reset width if it's too small to view.
   const getRectWidth = (rec: RectangleData) => {
    const width = scales.xScale(rec.end) - scales.xScale(rec.start);
    if (width <= 0) {
      return 2;
    }
    return width;
  }

  const handleSegmentMouseLeave = (event: React.MouseEvent) => {
    if (disableSegment) return;
    setSegTooltip({ visible: false, content: null, position: { x: 0, y: 0 } });
  };

  const handleSegmentOnClick = (
    event: React.MouseEvent,
    rectData: RectangleData
  ) => {
    if (disableSegment) return;
    //onDataChange()
  };

   // handle segment events
   const handleSegmentMouseOver = (
    event: React.MouseEvent,
    rectData: RectangleData
  ) => {
    if (disableSegment) return;
    setSegTooltip({
      visible: true,
      content: RenderSegmentTooltipContent(rectData),
      position: { x: event.pageX, y: event.pageY },
    });
  };


  return(
      <g className="rect-group">
              {rectangles.map((rec, i) => {
                return (
                  <rect
                    key={i}
                    className={`${styles.rect} rect`}
                    fill={rec.color ? rec.color : getRandomColor(i)}
                    id={rec.name}
                    display={disableSegment ? "none" : "block"}
                    x={scales.xScale(rec.start)}
                    y={0}
                    width={getRectWidth(rec)}
                    height={dimensions.ctrHeight}
                    onMouseOver={(event) => handleSegmentMouseOver(event, rec)}
                    onMouseLeave={handleSegmentMouseLeave}
                    onClick={(event) => handleSegmentOnClick(event, rec)}
                  />
                );
              })}
            </g>
  )
}
