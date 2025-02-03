import { getRandomColor } from "components/charts/line_chart_with_segments/d3_chart_utils/color";
import { PickerConfig } from "components/charts/line_chart_with_segments/d3_chart_utils/utils";
import LineChartWithSegments from "components/charts/line_chart_with_segments/LineChartWithSegments";
import { UtilizationMetadata } from "lib/utilization/types";
import { useEffect, useState } from "react";
import { getIgnoredSegmentName } from "./helper";

export const UtilizationPage = ({
  lines = [],
  metadata,
}: {
  lines: {
    name: string;
    records: { ts: string; value: number }[];
  }[];
  metadata: UtilizationMetadata;
}) => {
  const [testSegments, setTestSegments] = useState<any[]>([]);
  const [clickedTest, setClickedTest] = useState<string>("");

  useEffect(() => {
    const segments = metadata.segments;
    const filteredSeg = segments.filter((segment) => {
      for (const ignoreName of getIgnoredSegmentName()) {
        if (segment.name.includes(ignoreName)) {
          return false;
        }
      }
      return true;
    });

    setTestSegments(filteredSeg);
  }, [lines, metadata]);

  function clickTest(testName: string) {
    setClickedTest(testName);
  }

  function getLineCategoryConfig(): Map<string, PickerConfig> {
    return new Map([
      ["hardware", { category: "hardware", types: ["gpu", "cpu", "memory"] }],
      ["stats", { category: "stats", types: ["max", "avg"] }],
    ]);
  }

  return (
    <div>
      <div>Utilization</div>
      <LineChartWithSegments
        inputLines={lines}
        segments={testSegments}
        disableLineTooltip={false}
        disableSegment={true}
        linePickerConfig={getLineCategoryConfig()}
      ></LineChartWithSegments>
    </div>
  );
};
