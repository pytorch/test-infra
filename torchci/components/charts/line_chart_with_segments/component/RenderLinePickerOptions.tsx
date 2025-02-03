import { Dispatch, SetStateAction } from "react";
import { Line } from "../d3_chart_utils/types";
import { PickerConfig } from "../d3_chart_utils/utils";
import ChartPicker from "./helpers/ChartPicker";
import { CheckboxItem } from "./helpers/CheckboxGroup";
import DropList from "./helpers/DropList";
import styles from "./RenderLineChartComponents.module.css";

const RenderLinePickerOptions = ({
  lines,
  setLines,
  lineCategory,
  setLineCategory,
  linePickerConfig,
}: {
  lines: Line[];
  setLines: Dispatch<SetStateAction<Line[]>>;
  lineCategory: string;
  setLineCategory: Dispatch<SetStateAction<string>>;
  linePickerConfig: Map<string, PickerConfig>;
}) => {
  // handle the checkbox group for selecting lines
  const getLineCategoryGroup = (type: string) => {
    if (!linePickerConfig.has(type)) {
      return [];
    }
    const config = linePickerConfig.get(type);
    return config!.types.map((type) => {
      return {
        parentName: type,
        childGroup: getChildGroup("line", type),
      };
    });
  };

  const getChildGroup = (type: string, parentName: string) => {
    if (type === "line") {
      return lines
        .filter((line) => line.name.includes(parentName))
        .map((line) => {
          return {
            id: line.name,
            name: line.name,
            checked: !line.hidden,
          };
        });
    }
    return [];
  };

  const changeLineCateory = (category: string) => {
    setLineCategory(category);
  };

  const changeLineVisilibity = (checked: CheckboxItem[]) => {
    const newLines = lines.map((line) => {
      const checkedItem = checked.find((item) => item.id === line.name);
      if (checkedItem) {
        line.hidden = !checkedItem.checked;
      }
      return line;
    });
    setLines(newLines);
  };

  const getLineCategoryOptions = () => {
    const res = Array.from(linePickerConfig.keys()).map((key: any) => {
      return { value: key, name: key };
    });
    return res;
  };
  return (
    <div>
      <div className={styles.rowFlexCenter}>
        <div>Group by:</div>
        <DropList
          onChange={changeLineCateory}
          options={getLineCategoryOptions()}
        ></DropList>
      </div>
      <div>
        {lineCategory &&
        linePickerConfig &&
        linePickerConfig.has(lineCategory) ? (
          <ChartPicker
            nestCheckboxes={getLineCategoryGroup(lineCategory)}
            onChange={changeLineVisilibity}
          />
        ) : (
          <div></div>
        )}
      </div>
    </div>
  );
};

export default RenderLinePickerOptions;
