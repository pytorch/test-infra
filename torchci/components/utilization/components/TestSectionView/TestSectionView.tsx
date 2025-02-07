import {
  List,
  ListItemButton,
  ListItemText,
  Paper,
  styled,
} from "@mui/material";
import LineRectChart from "components/charts/line_rect_chart/LineRectChart";
import { ToggleGroup } from "components/common/ToggleGroup";
import { formatSeconds, getDuration } from "components/utilization/helper";
import { Segment } from "lib/utilization/types";
import { useEffect, useState } from "react";
import { Divider, InfoTitle } from "../../styles";
import { SingleTestView } from "./SingleTestView";

const toggleItems = [
  {
    name: "list view",
    value: "list",
  },
  {
    name: "chart view",
    value: "chart",
  },
];
const defaultTestViewValue = "list";

export const TestList = styled(Paper)({
  margin: "10px",
  padding: "10px",
  maxHeight: 300,
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
  const [pickedSegment, setPickedSegment] = useState<any | null>();
  const [renderSegments, setRenderSegments] = useState<Segment[]>([]);
  const [showSegmentLocation, setShowSegmentLocation] = useState<any | null>();
  const [selectedListItem, setSelectedListItem] = useState<string | null>();
  const [toggleTestView, setTestView] = useState<string>(defaultTestViewValue);

  useEffect(() => {
    const sorted = testSegments.sort((a, b) => {
      return getDuration(b) - getDuration(a);
    });
    setRenderSegments(sorted);
  }, [testSegments, timeSeriesList]);

  function clickChartTest(id: string) {
    renderView(id);
  }

  function handleListItemClick(name: string) {
    renderView(name);
  }

  function renderView(id: string) {
    const segment = renderSegments.find((segment) => segment.name === id);
    if (!segment) return;
    setPickedSegment({ opacity: 0.9, color: "red", ...segment });
    setSelectedListItem(segment.name);
    setShowSegmentLocation({ opacity: 0.9, color: "red", ...segment });
  }

  function handleToggleTestView(value: string) {
    const item = toggleItems.find((item) => item.value === value);
    if (!item) {
      setTestView("list");
    }
    setTestView(value);
  }

  if (renderSegments.length === 0) return <div></div>;

  return (
    <div>
      <h3>Detected python test details</h3>
      <Divider />
      <div>
        <InfoTitle>Tests ({renderSegments.length}) </InfoTitle>
        <Description>
          {`We detected (${renderSegments.length}) tests on python_CMD level,`}
        </Description>
        <ToggleGroup
          defaultValue={"list"}
          items={toggleItems}
          onChange={handleToggleTestView}
        />
        {toggleTestView == "list" && (
          <FlexSection>
            <div>
              <div> click on the test name to see the single test details:</div>
              <TestList>
                <List>
                  {renderSegments.map((segment) => (
                    <ListItemButton
                      dense
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
        )}
      </div>
      {toggleTestView == "chart" && (
        <div>
          <Description>
            Click on the test segment on the graph to see the test details.
          </Description>
          <LineRectChart
            inputLines={timeSeriesList}
            chartWidth={1200}
            rects={renderSegments}
            disableLineTooltip={true}
            disableRect={false}
            onClickedRect={clickChartTest}
          ></LineRectChart>
        </div>
      )}
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
  );
};
