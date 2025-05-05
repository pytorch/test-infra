import { Divider, styled } from "@mui/material";
import LineRectChart from "components/charts/line_rect_chart/LineRectChart";
import {
  formatSeconds,
  getDuration,
  getSegmentStatsAndTimeSeries,
} from "components/utilization/JobUtilizationPage/helper";
import { lineFilters } from "components/utilization/JobUtilizationPage/JobUtilizationPage";
import {
  InfoCard,
  InfoSection,
  InfoTitle,
} from "components/utilization/JobUtilizationPage/styles";
import { Segment, TimeSeriesWrapper } from "lib/utilization/types";
import { useEffect, useState } from "react";
import UtilizationJobMetricsTable from "../UtilizationStatsTable";

const StatsTable = styled("div")({
  maxWidth: "1400px",
  margin: "10px",
});

const GraphGroupSection = styled("div")({
  display: "flex",
  margin: "10px",
});

const SingleGraphSection = styled("div")({
  margin: "5px",
  padding: "10px",
});

export const SingleTestView = ({
  testSegment,
  timeSeriesList,
}: {
  testSegment: Segment;
  timeSeriesList: TimeSeriesWrapper[];
}) => {
  const [testTimeSeries, setTestTimeSeries] = useState<TimeSeriesWrapper[]>([]);
  const [testStats, setTestStats] = useState<any[]>([]);
  useEffect(() => {
    if (!testSegment || !timeSeriesList) return;
    if (timeSeriesList.length === 0) {
      console.log(
        "No time series data received for single test view",
        testSegment.name
      );
      return;
    }

    if (timeSeriesList[0].records.length === 0) {
      console.log(
        "No time series [0] received for single test view",
        testSegment.name
      );
    }

    const result = getSegmentStatsAndTimeSeries(testSegment, timeSeriesList);
    if (!result) {
      console.log(
        "[internal] unable to process the data, something is wrong",
        testSegment.name
      );
      return;
    }
    setTestTimeSeries(result.timeSeries);
    setTestStats(result.stats);
  }, [testSegment, timeSeriesList]);

  return (
    <div>
      <h1>Selected Test Segment Details</h1>
      <Divider />
      <InfoCard>
        <InfoSection>
          <InfoTitle>Test Name:</InfoTitle>
          <span>{testSegment.name}</span>
        </InfoSection>
        <InfoSection>
          <InfoTitle>Test Level:</InfoTitle>
          <span>{testSegment.level.toLocaleLowerCase()}</span>
        </InfoSection>
        <InfoSection>
          <InfoTitle>Github search :</InfoTitle>
          <span>
            <a href={getGithubSearchLink(testSegment.name)}>link</a>
          </span>
        </InfoSection>
        <InfoSection>
          <InfoTitle>Test Duration:</InfoTitle>
          <span>{formatSeconds(getDuration(testSegment))}</span>
        </InfoSection>
        <InfoSection>
          <InfoTitle>Test Start:</InfoTitle>
          <span>{new Date(testSegment.start_at).toLocaleString()}</span>
        </InfoSection>
        <InfoSection>
          <InfoTitle>Test End:</InfoTitle>
          <span>{new Date(testSegment.end_at).toLocaleString()}</span>
        </InfoSection>
      </InfoCard>
      <GraphGroupSection>
        <SingleGraphSection>
          {testTimeSeries && (
            <LineRectChart
              inputLines={testTimeSeries}
              chartWidth={1000}
              disableLineTooltip={false}
              disableRect={true}
              lineFilterConfig={lineFilters}
            ></LineRectChart>
          )}
        </SingleGraphSection>
        <SingleGraphSection>
          <div> Location of the test: </div>
          <LineRectChart
            inputLines={timeSeriesList}
            chartWidth={700}
            rects={[testSegment]}
            disableLineTooltip={true}
            disableRect={false}
          ></LineRectChart>
        </SingleGraphSection>
      </GraphGroupSection>
      <div>
        {testStats && (
          <StatsTable>
            <UtilizationJobMetricsTable data={testStats} />
          </StatsTable>
        )}
      </div>
    </div>
  );
};

function getGithubSearchLink(testName: string) {
  const head = "https://github.com/search?q=repo%3Apytorch%2Fpytorch%20%20";
  const repo = `${testName}`;
  const encodedString = encodeURIComponent(repo);
  const url = head + `"` + encodedString + `"&type=code`;
  return url;
}
