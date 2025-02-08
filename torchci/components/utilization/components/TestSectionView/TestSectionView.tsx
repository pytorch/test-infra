import { Paper } from "@mui/material";
import { getDuration } from "components/utilization/helper";
import { Segment } from "lib/utilization/types";
import { useEffect, useState } from "react";
import { Blank, Description, Divider, InfoTitle } from "../../styles";
import { SingleTestView } from "./SingleTestView";
import ToggleTestsGroup from "./ToggleTestsGroup";

export const TestSectionView = ({
  testSegments,
  timeSeriesList,
}: {
  testSegments: Segment[];
  timeSeriesList: any[];
}) => {
  const [pickedSegment, setPickedSegment] = useState<any | null>();
  const [renderSegments, setRenderSegments] = useState<Segment[]>([]);

  useEffect(() => {
    const sorted = testSegments.sort((a, b) => {
      return getDuration(b) - getDuration(a);
    });
    setRenderSegments(sorted);
  }, [testSegments, timeSeriesList]);

  if (renderSegments.length === 0) return <div></div>;

  const pickSegment = (segment: any) => {
    setPickedSegment(segment);
  };

  return (
    <div>
      <h3>Detected python test details</h3>
      <Divider />
      <div>
        <InfoTitle>Tests ({renderSegments.length}) </InfoTitle>
        <Description>
          {`We detected (${renderSegments.length}) tests on PYTHON_CMD level`}
        </Description>
        {renderSegments.length > 0 && timeSeriesList.length > 0 && (
          <ToggleTestsGroup
            pickSegment={pickSegment}
            segments={renderSegments}
            timeSeriesList={timeSeriesList}
          />
        )}
        <div>
          {pickedSegment ? (
            <Paper>
              <SingleTestView
                testSegment={pickedSegment}
                timeSeriesList={timeSeriesList}
              />
            </Paper>
          ) : (
            <Blank></Blank>
          )}
        </div>
      </div>
    </div>
  );
};
