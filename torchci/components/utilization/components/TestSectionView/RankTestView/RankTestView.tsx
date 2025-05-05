import DropDownList from "components/common/DropDownList";
import { getSegmentStatsAndTimeSeries } from "components/utilization/JobUtilizationPage/helper";
import { FlexSection } from "components/utilization/JobUtilizationPage/styles";
import { StatType } from "components/utilization/JobUtilizationPage/types";
import { Segment, TimeSeriesWrapper } from "lib/utilization/types";
import { cloneDeep } from "lodash";
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

const DefaultResourceNames = [
  {
    name: "cpu",
    value: "cpu",
  },
  {
    name: "memory",
    value: "memory",
  },
];

const DefaultGpuResourceValue = [
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
  selectedId = "",
  timeSeriesList,
  segments,
}: {
  onRankClick?: (id: string) => void;
  selectedId?: string | null;
  timeSeriesList: TimeSeriesWrapper[];
  segments: Segment[];
}) => {
  const [rankData, setRankData] = useState<any[]>([]);
  const [selectResource, setSelectResource] = useState<string>("");
  const [selectStat, setSelectStat] = useState<string>("");
  const [resourceNames, setResourceNames] = useState<any[]>([]);

  useEffect(() => {
    const rankData = processRankData(segments, timeSeriesList);
    let names = cloneDeep(DefaultResourceNames);

    if (rankData.find((d) => d.resourceName.includes("gpu"))) {
      names = [...names, ...DefaultGpuResourceValue];
    }

    setRankData(rankData);
    setResourceNames(names);

    if (names.length === 0 || statsNames.length == 0) {
      return;
    }

    setSelectResource(names[0].value);
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
          defaultValue={"cpu"}
          options={resourceNames}
        />
        <DropDownList
          onChange={function (value: string): void {
            setSelectStat(value);
          }}
          defaultValue={StatType.Average}
          options={statsNames}
        />
      </FlexSection>
      <div>
        <RankBar
          data={rankData}
          resourceName={selectResource}
          statType={selectStat}
          onRankClick={onRankClick}
          selectedId={selectedId}
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
