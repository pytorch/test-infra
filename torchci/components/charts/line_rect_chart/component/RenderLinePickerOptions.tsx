import { Dispatch, SetStateAction, useEffect, useState } from "react";
import { Line, PickerConfig } from "../lib/types";
import { CheckboxItem } from "./helpers/CheckboxGroup";
import DropList from "./helpers/DropList";
import styles from "./RenderLineChartComponents.module.css";
import ChartCheckboxGroups from "./helpers/ChartCheckboxGroups";
import { use } from "echarts";
import { set } from "lodash";

const RenderLinePickerOptions = ({
  lines,
  setLines,
  lineCategory,
  setLineCategory,
  lineFilterConfig,
}: {
  lines: Line[];
  setLines: (line:Line[]) => void;
  lineCategory: string;
  setLineCategory: (category:string)=>void;
  lineFilterConfig: PickerConfig[];
}) => {

  const [options, setOptions] = useState<any>([]);
  const [groups, setGroups] = useState<any>([]);

  useEffect(() => {
    let options = lineFilterConfig.map((config) => {
      return { value: config.category, name: config.category }
    })
    setOptions(options);

    const config = lineFilterConfig.find((item)=> item.category==lineCategory)
    if (!config) {
        return;
    }
    const res = config.types.map((type) => {
      return {
        parentName: type,
        childGroup: getChildGroup("line", type),
      };
    });
    setGroups(res);
  },[lines,lineCategory,lineFilterConfig])

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
  return (
    <div>
      {options && (
        <div className={styles.rowFlexCenter}>
          <div>Group by:</div>
          <DropList
            onChange={changeLineCateory}
            options={options}
          ></DropList>
        </div>
      )}
      <div className={styles.linePickerGroup}>
        {groups &&
        (
          <ChartCheckboxGroups
            groups={groups}
            onChange={changeLineVisilibity}
          />
        )}
      </div>
    </div>
  );
};

export default RenderLinePickerOptions;
