import * as d3 from "d3";
import { D3LineRecord, Line, RectangleData } from "../d3_chart_utils/types";
import { formatDate, xAccessor, yAccessor } from "../d3_chart_utils/utils";
import styles from "./RenderLineChartComponents.module.css";

export function RenderLineTooltipContent(
  date: Date,
  lineList: Line[],
  maps: Map<string, D3LineRecord>
) {
  const formattedDate = formatDate(date);
  return (
    <div className={styles.tooltipline}>
      <div>{formattedDate}</div>
      <div>
        {lineList.map((item) => {
          if (item.hidden) {
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

export function RenderSegmentTooltipContent(rec: RectangleData) {
  return (
    <div className={styles.tooltipline}>
      <div>
        <div>{rec.name}</div>
        <div>Start: {formatDate(rec.start)}</div>
        <div>End: {formatDate(rec.end)}</div>
      </div>
    </div>
  );
}

export function RenderIndicatorLine(
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
export function RenderTooltipCircles(
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
