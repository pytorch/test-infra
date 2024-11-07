import { styled, SxProps, Theme } from "@mui/material";
import LabelGuide from "components/common/LabelGuide";
import { getJobConclusionElementList } from "components/JobConclusion";
import jobConclustionStyles from "components/JobConclusion.module.css";
import { getGroupConclusionElementList } from "./GroupJobConclusion";

const conclusionIndicatorProps: SxProps<Theme> = {
  top: "0px",
  left: "6px",
  maxWidth: "140px",
  zIndex: 1,
};

const conclusionGroupIndicatorProps: SxProps<Theme> = {
  top: "0px",
  left: "150px",
  maxWidth: "140px",
  zIndex: 1,
};

const BlankSpace = styled("div")(({}) => ({
  height: "40px",
}));

const GroupHudTableLabelContainer = styled("div")(({}) => ({
  position: "relative",
}));

const LabelGroup = styled("div")(({}) => ({
    position: "absolute",
}));

export default function GroupHudTableLabelGuide() {
  return (
    <>
      <BlankSpace />
      <GroupHudTableLabelContainer>
        <LabelGroup>
            <LabelGuide
            title="Job Label"
            props={conclusionIndicatorProps}
            labelInfoList={getJobConclusionElementList()}
            labelStyleList={jobConclustionStyles}
            />
            <LabelGuide
            title="Group Label"
            props={conclusionGroupIndicatorProps}
            labelInfoList={getGroupConclusionElementList()}
            labelStyleList={jobConclustionStyles}
            />
        </LabelGroup>
      </GroupHudTableLabelContainer>
      <BlankSpace />
    </>
  );
}
