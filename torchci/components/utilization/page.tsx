import { getRandomColor } from "components/charts/line_chart_with_segments/d3_chart_utils/color";
import LineChartWithSegments from "components/charts/line_chart_with_segments/LineChartWithSegments";
import { color } from "echarts";
import { UtilizationMetadata } from "lib/utilization/types";
import { findClosestDate } from "./helper";
import useSWR from "swr";
import { useEffect, useState } from "react";
import { setServers } from "dns";

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
  const [testSegments, setTestSegments] = useState<any[]>([])
  const [clickedTest, setClickedTest] = useState<string>("")

  useEffect(() => {
    const segments = metadata.segments;
    const filteredSeg = segments.filter((segment) => {
      return !segment.name.includes("tools.stats.monitor") && !segment.name.includes("pip install") && !segment.name.includes("filter_test_configs.py");
    });
    setTestSegments(filteredSeg);
  }, [lines,metadata])

  function clickTest(testName:string) {
    setClickedTest(testName);
  }

  return (
    <div>
      <div>Utilization</div>
      <LineChartWithSegments
        inputLines={lines}
        segments={testSegments}
        disableLine={false}
        disableSegment={false}
        selectedSegmentId={clickedTest}
      ></LineChartWithSegments>
      <pre>{JSON.stringify(testSegments, null, 2)}</pre>
      <div>Test Clicked: {clickedTest}</div>
      <div>
        {testSegments.map((segment,i) => {
          return <button key={segment.name} style={{color: getRandomColor(i)}} onClick={(e) => clickTest(segment.name)}>{segment.name}</button>;
        })}
      </div>
    </div>
  );
};
