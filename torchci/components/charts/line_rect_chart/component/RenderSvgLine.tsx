import * as d3 from "d3";
import { getRandomColor } from "../lib/color";
import { D3LineRecord, Line } from "../lib/types";

/**
 * handle svg line rendering for LineRectChart
 */
const RenderSvgLines = ({ scales, lines }: { scales: any; lines: Line[] }) => {
  const lineGenerator = d3
    .line<D3LineRecord>()
    .x((d: D3LineRecord) => scales.xScale(d.date))
    .y((d: D3LineRecord) => scales.yScale(d.value));

  return (
    <g className="lines-group">
      {lines.map((line, i) => {
        return (
          <path
            key={i}
            d={lineGenerator(line.records)?.toString()}
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
  );
};

export default RenderSvgLines;
