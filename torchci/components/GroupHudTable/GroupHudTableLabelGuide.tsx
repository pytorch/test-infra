import { Button, Modal, styled, SxProps, Theme } from "@mui/material";
import LabelGuide from "components/common/LabelGuide";
import { getJobConclusionElementList } from "components/JobConclusion";
import jobConclustionStyles from "components/JobConclusion.module.css";
import React from "react";
import { getGroupConclusionElementList } from "./GroupJobConclusion";

const conclusionIndicatorProps: SxProps<Theme> = {
  maxWidth: "140px",
  zIndex: 1,
};

const conclusionGroupIndicatorProps: SxProps<Theme> = {
  maxWidth: "140px",
  zIndex: 1,
};

const GroupHudTableLabelContainer = styled("div")(({}) => ({
  position: "relative",
}));

const StyledModal = styled(Modal)({
  top: "220px",
});

export const LabelGroup = styled("div")(({}) => ({
  position: "fixed",
  left: "6px",
  top: "220px",
  zIndex: 1,
}));

export const ModalGroup = styled("div")(({}) => ({
  width: "300px",
  display: "flex",
  flexDirection: "row",
}));

export default function GroupHudTableLabelGuide() {
  const [isVisible, setIsVisible] = React.useState(false);
  const handleToggleVisibility = () => {
    setIsVisible(!isVisible);
  };
  return (
    <LabelGroup>
      <Button variant="contained" onClick={handleToggleVisibility}>
        {isVisible ? "close" : "view label"}
      </Button>
      {isVisible && (
        <ModalGroup>
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
        </ModalGroup>
      )}
    </LabelGroup>
  );
}
