import { Dispatch, SetStateAction } from "react";
import { getRandomColor } from "../lib/color";
import { RectangleData } from "../lib/types";
import { formatDate } from "../lib/utils";
import styles from "./RenderLineChartComponents.module.css";

const RenderSvgRects = ({
  onClickedRect,
  setRectTooltip,
  rectangles,
  disableRect,
  dimensions,
  scales,
}: {
  setRectTooltip: Dispatch<
    SetStateAction<{
      visible: boolean;
      content: any;
      position: {
        x: number;
        y: number;
      };
    }>
  >;
  onClickedRect: (id: any) => void;
  rectangles: RectangleData[];
  disableRect?: boolean;
  dimensions: any;
  scales: any;
}) => {
  // helper function to get the width of a rectangle, reset width if it's too small to view.
  const getRectWidth = (rec: RectangleData) => {
    const width = scales.xScale(rec.end) - scales.xScale(rec.start);
    if (width <= 0) {
      return 2;
    }
    return width;
  };

  const handleSegmentMouseLeave = (event: React.MouseEvent) => {
    if (disableRect) return;
    setRectTooltip({ visible: false, content: null, position: { x: 0, y: 0 } });
  };

  const handleSegmentOnClick = (
    event: React.MouseEvent,
    rectData: RectangleData
  ) => {
    if (disableRect) return;

    console.log("RenderSvgRects", rectData);
    onClickedRect(rectData.name);
  };

  // handle rect svg events
  const handleSegmentMouseOver = (
    event: React.MouseEvent,
    rectData: RectangleData
  ) => {
    if (disableRect) return;
    setRectTooltip({
      visible: true,
      content: RenderSegmentTooltipContent(rectData),
      position: { x: event.pageX, y: event.pageY },
    });
  };

  return (
    <g className="rect-group">
      {rectangles.map((rec, i) => {
        return (
          <rect
            key={i}
            className={`${styles.rect} rect`}
            opacity={rec.opacity ? rec.opacity : 0.5}
            fill={rec.color ? rec.color : getRandomColor(i)}
            id={rec.name}
            display={disableRect ? "none" : "block"}
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
  );
};

function RenderSegmentTooltipContent(rec: RectangleData) {
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

export default RenderSvgRects;
