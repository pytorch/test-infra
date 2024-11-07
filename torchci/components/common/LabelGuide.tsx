import Paper from "@mui/material/Paper";
import { styled, SxProps, Theme } from "@mui/material/styles";
import React from "react";

// Define the styles for Indicator box component
const Item = styled(Paper)(({ theme }) => ({
  ...theme.typography.body2,
  padding: theme.spacing(1),
  color: theme.palette.text.secondary,
  display: "flex",
  justifyContent: "flex-start",
  flexWrap: "wrap",
}));

const IndicatorItem = styled("div")(({}) => ({
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
}));

const IndicatorIcon = styled("div")(({}) => ({
  fontSize: "15px",
  marginRight: "6px",
  marginLeft: "10px",
  height: "auto",
}));

const IndicatorBoxTitle = styled("div")(({}) => ({
  marginBottom: "5px",
}));

/**
 * Props for IndicatorList component
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
      <IndicatorBoxTitle>{title ? `${title} :` : ""}</IndicatorBoxTitle>
      {labelInfoList.map((labelInfo, index) => (
        <IndicatorItem key={index}>
          <IndicatorIcon key={index}>
            {" "}
            {labelInfo.render(
              labelStyleList ? labelStyleList[labelInfo.type] : undefined
            )}
          </IndicatorIcon>
          <div>{labelInfo.name}</div>
        </IndicatorItem>
      ))}
    </Item>
  );
}
export default LabelGuide;
