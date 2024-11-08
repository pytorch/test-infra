import { Button, Paper, styled, SxProps, Theme } from "@mui/material";
import LabelGuide from "components/common/LabelGuide";
import { getJobConclusionElementList } from "components/JobConclusion";
import jobConclustionStyles from "components/JobConclusion.module.css";
import React from "react";
import { getGroupConclusionElementList } from "./GroupJobConclusion";

const conclusionIndicatorProps: SxProps<Theme> = {
  maxWidth: "140px",
};

const conclusionGroupIndicatorProps: SxProps<Theme> = {
  maxWidth: "140px",
  zIndex: 1,
};

const LabelGroup = styled(Paper)(({ theme }) => ({
  zIndex: 100,
  position: "fixed",
  right: "6px",
  top: "190px",
  ...theme.typography.body2,
  color: theme.palette.text.secondary,
}));

const ModalGroup = styled("div")(({}) => ({
  width: "300px",
  display: "flex",
  justifyContent: "space-evenly",
  flexDirection: "row",
  paddingBottom: "10px",
}));

const ButtonContainer = styled("div")(({}) => ({
  display: "flex",
  justifyContent: "flex-end",
}));

const LabelGroupButton = styled(Button)(({ theme }) => ({
  color: theme.palette.primary.light,
  backgroundColor: "white",
  size: "small",
}));

export default function GroupHudTableLabelGuide() {
  const [isVisible, setIsVisible] = React.useState(true);
  const handleToggleVisibility = () => {
    setIsVisible(!isVisible);
  };
  return (
    <LabelGroup>
      <ButtonContainer>
        <LabelGroupButton onClick={handleToggleVisibility}>
          {isVisible ? "hide" : "view label"}
        </LabelGroupButton>
      </ButtonContainer>
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
