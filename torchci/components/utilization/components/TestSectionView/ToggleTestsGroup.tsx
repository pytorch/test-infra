import {
  List,
  ListItemButton,
  ListItemText,
  Paper,
  styled,
} from "@mui/material";
import LineRectChart from "components/charts/line_rect_chart/LineRectChart";
import { ToggleGroup } from "components/common/ToggleGroup";
import {
  formatSeconds,
  getDuration,
} from "components/utilization/JobUtilizationPage/helper";
import {
  Description,
  FlexSection,
} from "components/utilization/JobUtilizationPage/styles";
import { Segment } from "lib/utilization/types";
import { useState } from "react";
import { RankTestView } from "./RankTestView/RankTestView";

const toggleItems = [
  {
    name: "chart view",
    value: "chart",
  },
  {
    name: "list view",
    value: "list",
  },
  {
    name: "rank view",
    value: "rank",
  },
];
export const TestList = styled(Paper)({
  margin: "10px",
  padding: "10px",
  maxHeight: 300,
  maxWidth: 800,
  overflow: "auto",
  backgroundColor: "var(--table-row-odd-bg)",
});
const defaultTestViewValue = "chart";

export const ToggleTestsGroup = ({
  pickSegment,
  segments,
  timeSeriesList,
}: {
  pickSegment: (segment: any) => void;
  segments: Segment[];
  timeSeriesList: any[];
}) => {
  const [showSegmentLocation, setShowSegmentLocation] = useState<any | null>();
  const [selectedListItem, setSelectedListItem] = useState<string | null>();
  const [toggleTestView, setTestView] = useState<string>(defaultTestViewValue);

  function handleToggleTestView(value: string) {
    const item = toggleItems.find((item) => item.value === value);
    if (!item) {
      setTestView("list");
    }
    setTestView(value);
  }

  function clickChartTest(id: string) {
    renderView(id);
  }

  function handleListItemClick(id: string) {
    renderView(id);
  }

  function handleRankViewClick(id: string) {
    renderView(id);
  }

  function renderView(id: string) {
    const segment = segments.find((segment) => segment.name === id);
    if (!segment) return;
    pickSegment({ opacity: 0.9, color: "red", ...segment });
    setSelectedListItem(segment.name);
    setShowSegmentLocation({ opacity: 0.9, color: "red", ...segment });
  }

  return (
    <div>
      <ToggleGroup
        defaultValue={defaultTestViewValue}
        items={toggleItems}
        onChange={handleToggleTestView}
      />
      {toggleTestView == "list" && (
        <FlexSection>
          <div>
            <Description>
              {" "}
              click on the test name to see the single test details:
            </Description>
            <TestList>
              <List>
                {segments.map((segment) => (
                  <ListItemButton
                    dense
                    key={segment.name}
                    disableGutters
                    sx={{
                      color:
                        selectedListItem === segment.name ? "blue" : "inherit",
                    }}
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
            <div>
              <div> Location of the test: </div>
              <LineRectChart
                inputLines={timeSeriesList}
                chartWidth={800}
                rects={showSegmentLocation ? [showSegmentLocation] : []}
                disableLineTooltip={true}
                disableRect={false}
              ></LineRectChart>
            </div>
          </div>
        </FlexSection>
      )}
      {toggleTestView == "chart" && (
        <div>
          <Description>
            Click on the test segment on the graph to see the test details.
          </Description>
          <LineRectChart
            inputLines={timeSeriesList}
            chartWidth={1200}
            rects={segments}
            disableLineTooltip={true}
            disableRect={false}
            onClickedRect={clickChartTest}
          ></LineRectChart>
        </div>
      )}
      {toggleTestView == "rank" && (
        <RankTestView
          timeSeriesList={timeSeriesList}
          segments={segments}
          onRankClick={handleRankViewClick}
          selectedId={selectedListItem}
        />
      )}
    </div>
  );
};

export default ToggleTestsGroup;
