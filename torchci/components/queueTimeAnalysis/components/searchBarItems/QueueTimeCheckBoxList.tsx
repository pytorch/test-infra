import { styled } from "@mui/material";
import CheckBoxList from "components/common/CheckBoxList";
import dayjs from "dayjs";
import { useClickHouseAPIImmutable } from "lib/GeneralUtils";
import { cloneDeep } from "lodash";
import { useEffect, useRef, useState } from "react";
import QueueTimeCategoryPicker from "../pickers/QueueTimeCategoryPicker";
import {
  DenseCheckbox,
  DenseTextField,
  DropboxSelectDense,
  FontSizeStyles,
  RainbowScrollStyle,
} from "./SharedUIElements";

interface Props {
  workflow_names: string[];
  job_names: string[];
  machine_types: string[];
  runner_labels: string[];
  repos: string[];
}

enum Category {
  workflow_name = "workflow_name",
  job_name = "job_name",
  machine_type = "machine_type",
  runner_label = "runner_label",
}

const HelperContent = styled("div")(({}) => ({
  margin: "5px",
}));

const CheckListStyle = {
  minHeight: "200px",
  height: "40vh",
  overflowY: "auto",
  border: "1px solid #e0e0e0",
  ...RainbowScrollStyle,
};

export default function QueueTimeCheckBoxList({
  startDate,
  endDate,
  updateFields,
  inputCategory,
  inputItems,
}: {
  startDate: dayjs.Dayjs;
  endDate: dayjs.Dayjs;
  updateFields: any;
  inputCategory: string;
  inputItems: string[];
}) {
  const [selectedItem, setSelectedItem] = useState<{ [key: string]: boolean }>(
    {}
  );

  const [category, setCategory] = useState<string>(
    inputCategory ? inputCategory : Category.workflow_name
  );
  const timeParams = {
    startTime: startDate.utc().format("YYYY-MM-DDTHH:mm:ss"),
    endTime: endDate.utc().format("YYYY-MM-DDTHH:mm:ss"),
  };

  const prevCategory = useRef<string | null>(null);

  const { data, isLoading } = useClickHouseAPIImmutable(
    "queue_time_analysis/queue_time_search_items",
    timeParams
  );

  useEffect(() => {
    if (!data) {
      return;
    }

    let items = [];
    switch (category) {
      case "workflow_name":
        items = cloneDeep(data[0].workflow_names);
        break;
      case "job_name":
        items = cloneDeep(data[0].job_names);
        break;
      case "machine_type":
        items = cloneDeep(data[0].machine_types);
        break;
      case "runner_label":
        items = cloneDeep(data[0].runner_labels);
        break;
      default:
        break;
    }

    let newSelectedItem: { [x: string]: boolean } = {};

    // initial category, set all items based on inputItems
    if (!prevCategory.current) {
      const inputSet = new Set(inputItems);
      newSelectedItem = items.reduce(
        (acc: { [x: string]: boolean }, item: string) => {
          acc[item] = inputSet.size > 0 ? inputSet.has(item) : false;
          return acc;
        },
        {}
      );
    } else {
      // if category is changed, set all items to true by default
      newSelectedItem = items.reduce(
        (acc: { [x: string]: boolean }, item: string) => {
          acc[item] = false;
          return acc;
        },
        {}
      );
    }

    if (prevCategory.current && prevCategory.current !== category) {
      const allSelected = Object.keys(items).every((key) => items[key]);

      let selected: any = [];
      if (!allSelected) {
        selected = Object.keys(newSelectedItem).filter(
          (key) => newSelectedItem[key]
        );
      }
      updateFields({ category, items: selected });
    }
    setSelectedItem(newSelectedItem);

    prevCategory.current = category;
  }, [data, category]);

  function setItems(items: { [x: string]: boolean }) {
    const allSelected = Object.keys(items).every((key) => items[key]);
    let selected: any = [];
    if (!allSelected) {
      selected = Object.keys(items).filter((key) => items[key]);
    }

    setSelectedItem(items);
    updateFields({ items: selected });
  }

  if (isLoading) {
    return <div></div>;
  }

  return (
    <div>
      <QueueTimeCategoryPicker
        setCategory={setCategory}
        category={category}
        sx={{
          ...DropboxSelectDense,
          ...FontSizeStyles,
        }}
      />
      <HelperContent sx={FontSizeStyles}> Select items: </HelperContent>
      <CheckBoxList
        items={selectedItem}
        onChange={(items) => setItems(items)}
        onClick={() => {}}
        sxConfig={{
          filter: {
            ...DenseTextField,
          },
          button: {
            textTransform: "none",
            padding: "4px 10px",
            ...FontSizeStyles,
          },
          list: { ...CheckListStyle },
          itemCheckbox: {
            ...DenseCheckbox,
            ...FontSizeStyles,
          },
          itemLabel: {
            whiteSpace: "normal", // allow wrapping
            wordBreak: "break-word",
            ...FontSizeStyles,
          },
        }}
      ></CheckBoxList>
    </div>
  );
}
