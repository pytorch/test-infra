import {
  List,
  ListItemButton,
  ListItemText,
  Paper,
  styled,
} from "@mui/material";
import LineRectChart from "components/charts/line_rect_chart/LineRectChart";
import { formatSeconds, getDuration } from "components/utilization/helper";
import { Segment } from "lib/utilization/types";
import { useEffect, useState } from "react";
import { Divider, InfoTitle } from "../../styles";
import { SingleTestView } from "./SingleTestView";

export const TestList = styled(Paper)({
  margin: "10px",
  padding: "10px",
  maxHeight: 500,
  maxWidth: 800,
  overflow: "auto",
  backgroundColor: "#f5f5f5",
});
export const FlexSection = styled("div")({
  margin: "5px",
  display: "flex",
});

export const Description = styled("div")({
  margin: "10px",
  padding: "10px",
  fontSize: "20px",
});

export const TestSectionView = ({
  testSegments,
  timeSeriesList,
}: {
  testSegments: Segment[];
  timeSeriesList: any[];
}) => {
  const [pickedSegment, setPickedSegment] = useState<Segment | null>();
  const [renderSegments, setRenderSegments] = useState<Segment[]>([]);
  const [showSegmentLocation, setShowSegmentLocation] =
    useState<Segment | null>();
  const [selectedListItem, setSelectedListItem] = useState<string | null>();

  useEffect(() => {
    const sorted = testSegments.sort((a, b) => {
      return getDuration(b) - getDuration(a);
    });
    setRenderSegments(sorted);
  }, [testSegments, timeSeriesList]);

  function clickTest(id: string) {
    const segment = renderSegments.find((segment) => segment.name === id);
    if (segment) {
      setPickedSegment(segment);
    }
  }

  function handleListItemClick(name: string) {
    setShowSegmentLocation(
      renderSegments.find((segment) => segment.name === name)
    );
    setSelectedListItem(name);
  }

  if (renderSegments.length === 0) return <div></div>;
  return (
    <div>
      <h3>Detected Python test details</h3>
      <Divider />
      <div>
        <InfoTitle>Tests ({renderSegments.length}) </InfoTitle>
        <Description>
          {`We detected (${renderSegments.length}) tests on python_CMD level,
          click on the test name to see the location of the test:`}
        </Description>
        <FlexSection>
          <div>
            <TestList style={{ maxHeight: 500, overflow: "auto" }}>
              <List>
                {renderSegments.map((segment) => (
                  <ListItemButton
                    key={segment.name}
                    disableGutters
                    onClick={() => handleListItemClick(segment.name)}
                    selected={segment.name == selectedListItem}
                  >
                    <ListItemText
                      primary={`${segment.name}`}
                      secondary={`Duration ${formatSeconds(
                        getDuration(segment)
                      )}`}
                    />
                  </ListItemButton>
                ))}
              </List>
            </TestList>
          </div>
          <div>
            {showSegmentLocation && (
              <div>
                <div> Location of the test: </div>
                <LineRectChart
                  inputLines={timeSeriesList}
                  chartWidth={800}
                  rects={[showSegmentLocation]}
                  disableLineTooltip={true}
                  disableRect={false}
                ></LineRectChart>
              </div>
            )}
          </div>
        </FlexSection>
      </div>
      <div>
        <InfoTitle> Single Test Details </InfoTitle>
        <Description>
          Click on the graph chart to see the test details.
        </Description>
        <LineRectChart
          inputLines={timeSeriesList}
          chartWidth={1200}
          rects={renderSegments}
          disableLineTooltip={true}
          disableRect={false}
          onClickedRect={clickTest}
        ></LineRectChart>
        <div>
          {pickedSegment && (
            <div>
              <SingleTestView
                testSegment={pickedSegment}
                timeSeriesList={timeSeriesList}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
