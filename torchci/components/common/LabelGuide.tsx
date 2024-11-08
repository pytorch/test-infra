import { styled, SxProps, Theme } from "@mui/material/styles";
import React from "react";

// Define the styles for label box component
const Item = styled("div")(({ theme }) => ({
  display: "flex",
  justifyContent: "flex-start",
  flexWrap: "wrap",
}));

const LabelItem = styled("div")(({}) => ({
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
}));

const LabelIcon = styled("div")(({}) => ({
  fontSize: "15px",
  marginRight: "6px",
  marginLeft: "10px",
  height: "auto",
}));

const LabelBoxTitle = styled("div")(({}) => ({
  marginBottom: "5px",
}));

/**
 * Props for LabelList component
 */
export interface LabelInfo {
  name: string;
  type: string;
  render: (className?: string) => JSX.Element;
}

export function LabelGuide({
  title,
  props,
  labelInfoList,
  labelStyleList,
}: {
  title?: string;
  props?: SxProps<Theme>;
  labelInfoList: LabelInfo[];
  labelStyleList?: { [key: string]: string };
}) {
  return (
    <Item sx={props}>
      <LabelBoxTitle>{title ? `${title} :` : ""}</LabelBoxTitle>
      {labelInfoList.map((labelInfo, index) => (
        <LabelItem key={index}>
          <LabelIcon key={index}>
            {" "}
            {labelInfo.render(
              labelStyleList ? labelStyleList[labelInfo.type] : undefined
            )}
          </LabelIcon>
          <div>{labelInfo.name}</div>
        </LabelItem>
      ))}
    </Item>
  );
}
export default LabelGuide;
