import {
  FormControl,
  FormHelperText,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
} from "@mui/material";
import CheckBoxList from "components/common/CheckBoxList";
import dayjs from "dayjs";
import { useClickHouseAPIImmutable } from "lib/GeneralUtils";
import { cloneDeep } from "lodash";
import { useEffect, useState } from "react";

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

const dynamicStyles = {
  height: "800px",
  overflowY: "auto", // Dynamically set overflow
  backgroundColor: "#f0f0f0",
  "&::-webkit-scrollbar": {
    width: "8px",
  },
  "&::-webkit-scrollbar-thumb": {
    backgroundColor: "#888",
    borderRadius: "10px",
  },
  "&::-webkit-scrollbar-track": {
    background: "#ccc",
  },
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
    inputCategory ? inputCategory : "workflow_name"
  );
  const timeParams = {
    startTime: startDate.utc().format("YYYY-MM-DDTHH:mm:ss"),
    endTime: endDate.utc().format("YYYY-MM-DDTHH:mm:ss"),
  };

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

    const inputSet = new Set(inputItems);
    newSelectedItem = items.reduce(
      (acc: { [x: string]: boolean }, item: string) => {
        acc[item] = inputSet.has(item);
        return acc;
      },
      {}
    );

    const selected = Object.keys(newSelectedItem).filter(
      (key) => newSelectedItem[key]
    );
    updateFields({ category, items: selected });
    setSelectedItem(newSelectedItem);
  }, [data, category]);

  function setItems(items: { [x: string]: boolean }) {
    setSelectedItem(items);
    const selected = Object.keys(items).filter((key) => items[key]);
    updateFields({ items: selected });
  }

  if (isLoading) {
    return <div></div>;
  }

  return (
    <div>
      <QueueTimeCategoryPicker setCategory={setCategory} category={category} />
      <CheckBoxList
        items={selectedItem}
        onChange={(items) => setItems(items)}
        onClick={() => {}}
        listSx={dynamicStyles}
      ></CheckBoxList>
    </div>
  );
}

function QueueTimeCategoryPicker({
  setCategory,
  category,
}: {
  setCategory: any;
  category: string;
}) {
  const handleChange = (event: SelectChangeEvent) => {
    setCategory(event.target.value);
  };
  return (
    <FormControl sx={{ m: 1, minWidth: 120 }}>
      <InputLabel id="category-picker-label">Search Category</InputLabel>
      <Select
        labelId="category-picker-select"
        id="category-picker-select"
        value={category}
        label="Category"
        onChange={handleChange}
      >
        <MenuItem value={"workflow_name"}>workflow name</MenuItem>
        <MenuItem value={"job_name"}>job name</MenuItem>
        <MenuItem value={"machine_type"}>machine type</MenuItem>
        <MenuItem value={"runner_label"}>runner_label</MenuItem>
      </Select>
      <FormHelperText>With label + helper text</FormHelperText>
    </FormControl>
  );
}
