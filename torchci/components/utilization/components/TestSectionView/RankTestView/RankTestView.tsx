import DropDownList from "components/common/DropDownList";
import { getSegmentStatsAndTimeSeries } from "components/utilization/helper";
import { FlexSection } from "components/utilization/styles";
import { StatType } from "components/utilization/types";
import { Segment, TimeSeriesWrapper } from "lib/utilization/types";
import { useEffect, useState } from "react";
import { RankBar } from "./RankBar";

const statsNames = [
  {
    name: "avg",
    value: StatType.Average,
  },
  {
    name: "max",
    value: StatType.Max,
  },
];

const reousrceNames = [
  {
    name: "cpu",
    value: "cpu",
  },
  {
    name: "memory",
    value: "memory",
  },
  {
    name: "all gpus utils",
    value: "gpus_util_all",
  },
  {
    name: "all gpu memory",
    value: "gpu_mem_all",
  },
];

export const RankTestView = ({
  onRankClick = (id: string) => {},
  timeSeriesList,
  segments,
}: {
  onRankClick?: (id: string) => void;
  timeSeriesList: TimeSeriesWrapper[];
  segments: Segment[];
}) => {
  const [rankData, setRankData] = useState<any[]>([]);
  const [selectResource, setSelectResource] = useState<string>("");
  const [selectStat, setSelectStat] = useState<string>("");

  useEffect(() => {
    const rankData = processRankData(segments, timeSeriesList);
    const reousrceNames = timeSeriesList.map((ts) => {
      return { name: ts.name, value: ts.name };
    });
    setRankData(rankData);
    setSelectResource(reousrceNames[0].value);
    setSelectStat(statsNames[0].value);
  }, [segments, timeSeriesList]);

  return (
    <div>
      <div>Rank Test View</div>
      <div>select resource and stats to pick the test you want to view</div>
      <FlexSection>
        <DropDownList
          onChange={function (value: string): void {
            setSelectResource(value);
          }}
          defaultValue={reousrceNames[0].value}
          options={reousrceNames}
        />
        <DropDownList
          onChange={function (value: string): void {
            setSelectStat(value);
          }}
          defaultValue={statsNames[0].value}
          options={statsNames}
        />
      </FlexSection>
      <div>
        <RankBar
          data={rankData}
          resourceName={selectResource}
          statType={selectStat}
          onRankClick={onRankClick}
        />
      </div>
    </div>
  );
};

function processRankData(
  segments: Segment[],
  timeSeriesList: TimeSeriesWrapper[]
) {
  let allData: any[] = [];
  for (const segment of segments) {
    const data = getSegmentStatsAndTimeSeries(segment, timeSeriesList);
    if (!data) {
      console.log(
        `unable to get stats and time series data for ${segment.name}, something is wrong`
      );
      continue;
    }
    // flatten data for each test segment
    // {resourceName:"cpu", columns:[{type:"avg", value:0.1}, {type:"max", value:0.2}]} to {resourceName:"cpu", avg:0.1, max:0.2}
    const flattenedData = data.stats.map((s) => {
      const obj = s.columns.reduce(
        (acc, item) => ({ ...acc, [item.type]: item.value }),
        {}
      );
      return {
        name: segment.name,
        resourceName: s.name,
        ...obj,
      };
    });
    allData = [...allData, ...flattenedData];
  }
  return allData;
}
