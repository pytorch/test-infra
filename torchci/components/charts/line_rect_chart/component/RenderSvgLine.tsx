import * as d3 from "d3";
import { getRandomColor } from "../lib/color";
import { D3LineRecord, Line } from "../lib/types";

/**
 * handle svg line rendering for LineRectChart
 */
const RenderSvgLines = ({
  scales,
  lines,
  lineConfigs,
}: {
  scales: any;
  lines: Line[];
  lineConfigs: { name: string; id: string; hidden: boolean }[];
}) => {
  const lineGenerator = d3
    .line<D3LineRecord>()
    .x((d: D3LineRecord) => scales.xScale(d.date))
    .y((d: D3LineRecord) => scales.yScale(d.value));
  return (
    <g className="lines-group">
      {lines.map((line, i) => {
        const hidden =
          lineConfigs.find((config) => config.id === line.id)?.hidden ?? false;
        return (
          <path
            key={i}
            d={lineGenerator(line.records)?.toString()}
            id={line.name + "-line"}
            className={"line"}
            fill="none"
            opacity={hidden ? 0.05 : 1}
            stroke={line.color ? line.color : getRandomColor(i)}
            strokeWidth={1.2}
          />
        );
      })}
    </g>
  );
};

export default RenderSvgLines;
