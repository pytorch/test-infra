import { useEffect, useState } from "react";
import {
  containsAllSubstrings,
  PickerConfig,
  PickerConfigType,
} from "../lib/types";
import ChartCheckboxGroups from "./helpers/ChartCheckboxGroups";
import { CheckboxItem } from "./helpers/CheckboxGroup";
import DropList from "./helpers/DropList";
import styles from "./RenderLineChartComponents.module.css";
const defaultCategory = "all";

const RenderLinePickerOptions = ({
  lines,
  setLines,
  lineFilterConfig,
}: {
  lines: { name: string; id: string; hidden: boolean }[];
  setLines: (line: any[]) => void;
  lineFilterConfig: PickerConfig[];
}) => {
  const [category, setCategory] = useState<string>(defaultCategory);
  const [options, setOptions] = useState<any>([]);
  const [groups, setGroups] = useState<any>([]);

  useEffect(() => {
    renderOptions();
    render();
  }, [lines, lineFilterConfig]);

  function renderOptions() {
    let options = lineFilterConfig.map((config) => {
      return { value: config.category, name: config.category };
    });
    setOptions(options);
  }

  function render() {
    const config = lineFilterConfig.find((item) => item.category == category);
    if (!config) {
      setGroups([]);
      return;
    }

    // render checkboxes
    const res = config.types.map((type) => {
      return {
        parentName: type.name,
        childGroup: getChildGroup(type, lines),
      };
    });
    setGroups(res);
  }

  function resetLines(category: string) {
    // clear all lines
    const newLines = lines.map((line) => {
      line.hidden = true;
      return line;
    });
    // show all lines in the selected category
    const config = lineFilterConfig.find((item) => item.category == category);
    if (config) {
      config.types.forEach((type) => {
        newLines.forEach((line) => {
          if (containsAllSubstrings(line.id, type.tags)) {
            line.hidden = false;
          }
        });
      });
    }
    setLines(newLines);
  }

  useEffect(() => {
    resetLines(category);
    render();
  }, [category]);

  const getChildGroup = (
    p: PickerConfigType,
    lines: { name: string; id: string; hidden: boolean }[]
  ) => {
    const res = lines
      .filter((line) => containsAllSubstrings(line.id, p.tags))
      .map((line) => {
        return {
          id: line.id,
          name: line.name,
          checked: !line.hidden,
        };
      });
    return res;
  };

  const changeLineCateory = (category: string) => {
    setCategory(category);
  };

  const changeLineVisilibity = (checked: CheckboxItem[]) => {
    const newLines = lines.map((line) => {
      const checkedItem = checked.find((item) => item.id === line.id);
      if (checkedItem) {
        line.hidden = !checkedItem.checked;
      }
      return line;
    });
    setLines(newLines);
  };

  return (
    <div>
      {options.length > 0 && (
        <div className={styles.rowFlexCenter}>
          <div>Group by:</div>
          <DropList
            onChange={changeLineCateory}
            options={options}
            defaultValue={defaultCategory}
          ></DropList>
        </div>
      )}
      {groups.length > 0 && (
        <div className={styles.linePickerGroup}>
          <ChartCheckboxGroups
            groups={groups}
            onChange={changeLineVisilibity}
          />
        </div>
      )}
    </div>
  );
};

export default RenderLinePickerOptions;
