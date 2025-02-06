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

const RenderLinePickerOptions = ({
  lines,
  setLines,
  lineFilterConfig,
}: {
  lines: { name: string; id: string; hidden: boolean }[];
  setLines: (line: any[]) => void;
  lineFilterConfig: PickerConfig[];
}) => {
  const [category, setCategory] = useState<string>("");
  const [options, setOptions] = useState<any>([]);
  const [groups, setGroups] = useState<any>([]);

  useEffect(() => {
    render();
  }, [lines, lineFilterConfig]);

  function render() {
    let options = lineFilterConfig.map((config) => {
      return { value: config.category, name: config.category };
    });
    setOptions(options);

    const config = lineFilterConfig.find((item) => item.category == category);
    if (!config) {
      setGroups([]);
      return;
    }
    const res = config.types.map((type) => {
      return {
        parentName: type.name,
        childGroup: getChildGroup(type, lines),
      };
    });
    setGroups(res);
  }

  function resetLines() {
    const newLines = lines.map((line) => {
      line.hidden = true;
      return line;
    });
    setLines(newLines);
  }

  useEffect(() => {
    resetLines();
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
          <DropList onChange={changeLineCateory} options={options}></DropList>
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
