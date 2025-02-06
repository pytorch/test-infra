import * as d3 from "d3";
import { Dispatch, SetStateAction } from "react";
import { D3LineRecord, Line } from "../lib/types";
import { formatDate, getRecordyDate, xAccessor, yAccessor } from "../lib/utils";
import styles from "./RenderLineChartComponents.module.css";

/**
 * svg element to handle line chart tooltips and evenßts.
 * this includes the indicator line, circles and tooltip.
 */
const RenderSvgLineTooltipElements = ({
  lines,
  lineConfigs,
  dimensions,
  scales,
  container,
  disableLineTooltip,
  setLineTooltip,
}: {
  lines: Line[];
  lineConfigs: any[];
  dimensions: any;
  scales: any;
  container: any;
  disableLineTooltip?: boolean;
  setLineTooltip: Dispatch<SetStateAction<any>>;
}) => {
  const handleLineMouseMove = (event: React.MouseEvent) => {
    if (disableLineTooltip) {
      return;
    }

    d3HandleMouseMovement(
      lines,
      lineConfigs,
      dimensions,
      scales.xScale,
      scales.yScale,
      container,
      event
    );
  };

  const handleLineMouseLeave = (event: React.MouseEvent) => {
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
    lineConfigs: any[],
    dimensions: any,
    xScale: any,
    yScale: any,
    container: any,
    event: { pageX: number; pageY: number }
  ) {
    if (lineList.length == 0) {
      return;
    }

    // Get the mouse position relative to the Xscale date range.
    const mousePos = d3.pointer(event, container.select(".overlay").node());
    const date = xScale.invert(mousePos[0]);

    // Get the closest data point to the mouse position
    const hoveredData = getRecordyDate(lineList[0].records, date);
    if (hoveredData == undefined) {
      console.log("No data from records found for date", date);
      return;
    }

    let lineDataMap = new Map<string, D3LineRecord>();
    for (const line of lineList) {
      const config = lineConfigs.find((c) => c.id === line.id);
      if (config == null || config.hidden) {
        continue;
      }
      const res = getRecordyDate(line.records, date);
      const diff = (res.date.getTime() - date.getTime()) / 1000;
      if (diff > 10) {
        continue;
      }
      lineDataMap.set(line.name, res);
    }
    if (lineDataMap.size == 0) {
      return;
    }

    // update tooltip, indicator line and circles based on mouse movement in chart.
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
    <g>
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
    </g>
  );
};

export function RenderLineTooltipContent(
  date: Date,
  lineList: Line[],
  maps: Map<string, D3LineRecord>
) {
  lineList.sort((a, b) => a.name.localeCompare(b.name));
  const formattedDate = formatDate(date);
  return (
    <div className={styles.tooltipline}>
      <div>{formattedDate}</div>
      <div>
        {lineList.map((item) => {
          if (!maps.has(item.name)) {
            return null;
          }
          const val = maps.get(item.name);
          return (
            <div key={item.name}>
              <div>
                {item.name}: {val?.value}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RenderIndicatorLine(
  container: any,
  xScale: any,
  record: D3LineRecord,
  height: number
) {
  container
    .select(".indicator-line")
    .attr("x1", xScale(xAccessor(record)))
    .attr("y1", 0)
    .attr("x2", xScale(xAccessor(record)))
    .attr("y2", height);
}
function RenderTooltipCircles(
  container: any,
  xScale: any,
  yScale: any,
  lineDataMap: Map<string, D3LineRecord>
) {
  container
    .selectAll(".tooltip-circle")
    .style("opacity", 1)
    .attr("cx", function (this: any) {
      var id = d3.select(this).attr("id");
      if (lineDataMap.has(id)) {
        const rec = lineDataMap.get(id);
        return xScale(xAccessor(rec!));
      }
      return 0;
    })
    .attr("cy", function (this: any) {
      var id = d3.select(this).attr("id");
      if (lineDataMap.has(id)) {
        const rec = lineDataMap.get(id);
        return yScale(yAccessor(rec!));
      }
      return 0;
    });
}

export default RenderSvgLineTooltipElements;
