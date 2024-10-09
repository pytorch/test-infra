import {
  Box,
  FormControl,
  FormGroup,
  Grid,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { DateTimePicker, LocalizationProvider } from "@mui/x-date-pickers";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import TimeSeriesPanel, {
  ChartType,
  Granularity,
} from "components/metrics/panels/TimeSeriesPanel";
import MultiSelectPicker from "components/MultiSelectPicker";
import dayjs from "dayjs";
import { fetcher } from "lib/GeneralUtils";
// import an image from the public folder, bar-chart.png
import Image from "next/image";
import { useRouter } from "next/router";
import React, { useEffect, useState } from "react";
import { FaFilter } from "react-icons/fa";
import useSWR from "swr";

function TimePicker({ label, value, setValue }: any) {
  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <DateTimePicker
        renderInput={(props) => <TextField {...props} />}
        label={label}
        value={value}
        onChange={(newValue) => {
          setValue(newValue);
        }}
      />
    </LocalizationProvider>
  );
}

/**
 * Allows the user to pick from common time ranges, or manually set their own.
 */
export function TimeRangePicker({
  startTime,
  setStartTime,
  stopTime,
  setStopTime,
  timeRange,
  setTimeRange,
  setGranularity,
}: {
  startTime: dayjs.Dayjs;
  setStartTime: any;
  stopTime: dayjs.Dayjs;
  setStopTime: any;
  timeRange: any;
  setTimeRange: any;
  setGranularity?: any;
}) {
  function handleChange(e: SelectChangeEvent<number>) {
    setTimeRange(e.target.value as number);
    // The user wants to set a custom time, don't change the start and stop
    // time.
    if (e.target.value !== -1) {
      const startTime = dayjs().subtract(e.target.value as number, "day");
      setStartTime(startTime);
      const stopTime = dayjs();
      setStopTime(stopTime);
    }

    if (setGranularity === undefined) {
      return;
    }

    // When setGranularity is provided, this picker can use it to switch to a
    // bigger granularity automatically when a longer time range is selected.
    // The users can still select a smaller granularity if they want to
    switch (e.target.value as number) {
      case 1:
      case 3:
      case 7:
      case 14:
        setGranularity("day");
        break;
      case 30:
      case 60:
        setGranularity("week");
      case 90:
      case 180:
      case 365:
        setGranularity("week");
        break;
    }
  }

  return (
    <>
      <FormControl>
        <InputLabel id="time-picker-select-label">Time Range</InputLabel>
        <Select
          value={timeRange}
          label="Time Range"
          labelId="time-picker-select-label"
          onChange={handleChange}
        >
          <MenuItem value={1}>Last 1 Day</MenuItem>
          <MenuItem value={3}>Last 3 Days</MenuItem>
          <MenuItem value={7}>Last 7 Days</MenuItem>
          <MenuItem value={14}>Last 14 Days</MenuItem>
          <MenuItem value={30}>Last Month</MenuItem>
          <MenuItem value={60}>Last 2 Months</MenuItem>
          <MenuItem value={90}>Last 3 Months</MenuItem>
          <MenuItem value={180}>Last 6 Months</MenuItem>
          <MenuItem value={365}>Last Year</MenuItem>
          <MenuItem value={-1}>Custom</MenuItem>
        </Select>
      </FormControl>
      {timeRange === -1 && (
        <>
          <TimePicker
            label={"Start Time"}
            value={startTime}
            setValue={setStartTime}
          />
          <TimePicker
            label={"Stop Time"}
            value={stopTime}
            setValue={setStopTime}
          />
        </>
      )}
    </>
  );
}

type CostCategory =
  | "runner_type"
  | "workflow_name"
  | "job_name"
  | "platform"
  | "provider"
  | "repo"
  | "gpu"
  | "os";

type YAxis = "cost" | "duration";

function splitString(input: string | string[]): string[] {
  if (Array.isArray(input)) {
    // Join the array into a single string, separating elements with a comma
    return input;
  }
  // If it's already a string, return it as is
  return input.split(",");
}

const costDisplay = (value: number) => {
  if (value < 1000) {
    return `$${value.toFixed(2)}`;
  }
  if (value < 10000) {
    return `$${(value / 1000).toFixed(1)}k`;
  }
  return `$${(value / 1000).toFixed(0)}k`;
};
// make an hour display function that shows int hours for everything < 1000 or 2.3k hours for everything > 1000
const hourDisplay = (value: number) => {
  if (value < 1000) {
    return `${value.toFixed(0)}h`;
  }
  if (value < 10000) {
    return `${(value / 1000).toFixed(1)}k h`;
  }
  return `${(value / 1000).toFixed(0)}k h`;
};

const ROW_HEIGHT = 700;

const OS_OPTIONS = ["linux", "windows", "macos"];
const GPU_OPTIONS = ["gpu", "non-gpu"];
const PROVIDER_OPTIONS = ["aws", "gcp", "github"];

export default function Page() {
  const router = useRouter();

  const { query } = router;

  const initialStartTime = query.startTime
    ? dayjs(query.startDate as string)
    : dayjs().subtract(7, "day");
  const initialStopTime = query.stopTime
    ? dayjs(query.endDate as string)
    : dayjs();
  const initialGranularity = query.granularity || "day";
  const initialGroupBy = query.groupby || "workflow_name";
  const initialChartType = query.chartType || "stacked_bar";
  const initialSelectedGPU = query.gpu
    ? splitString(query.gpu).map(Number)
    : [0, 1];

  const initialSelectedOS = query.os ? splitString(query.os) : OS_OPTIONS;

  const initialSelectedProviders = query.provider
    ? splitString(query.provider)
    : PROVIDER_OPTIONS;
  const initialSelectedYAxis = (query.yAxis as YAxis) || "cost";
  const initialSearchFilter = query.searchFilter || "";
  const initialSelectedRepos = query.repos
    ? splitString(query.repos)
    : undefined;

  console.log("Initial Selected Repos:", initialSelectedRepos);
  // State variables
  const [startTime, setStartTime] = useState(initialStartTime);
  const [stopTime, setStopTime] = useState(initialStopTime);
  const [selectedRepos, setSelectedRepos] = useState<string[]>();
  console.log("Selected Repos:", selectedRepos);

  const [granularity, setGranularity] = useState<Granularity>(
    initialGranularity as Granularity
  );
  const [timeRange, setTimeRange] = useState(7);
  const [groupby, setGroupBy] = useState<CostCategory>(
    initialGroupBy as CostCategory
  );
  const [chartType, setChartType] = useState<ChartType>(
    initialChartType as ChartType
  );
  const [selectedGPU, setSelectedGPU] = useState(initialSelectedGPU);
  const [selectedOS, setSelectedOS] = useState(initialSelectedOS);
  const [selectedProviders, setSelectedProviders] = useState(
    initialSelectedProviders
  );
  const [selectedYAxis, setSelectedYAxis] = useState<YAxis>(
    initialSelectedYAxis || "cost"
  );
  const [searchFilter, setSearchFilter] = useState(
    initialSearchFilter as string
  );

  const timeParamsClickHouse = {
    startTime: startTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: stopTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
  };

  const url = `/api/clickhouse/unique_repos_in_runnercost?parameters=${encodeURIComponent(
    JSON.stringify({
      ...timeParamsClickHouse,
    })
  )}`;

  var { data: repos, error, isLoading } = useSWR(url, fetcher);
  if (selectedRepos === undefined && repos !== undefined) {
    if (initialSelectedRepos) {
      console.log("Setting selected repos to initial selected repos");
      setSelectedRepos(initialSelectedRepos);
    } else {
      console.log("Setting selected repos to all repos");
      setSelectedRepos(repos.map((d: any) => d.repo));
    }
  } else {
    console.log("Selected repos is already set");
  }

  // Update URL params on state change
  useEffect(() => {
    if (!router.isReady) return;
    console.log("Updating URL params");

    const params = new URLSearchParams();
    if (startTime && stopTime) {
      params.set("startDate", startTime.utc().format("YYYY-MM-DD"));
      params.set("endDate", stopTime.utc().format("YYYY-MM-DD"));
    }

    if (granularity) params.set("granularity", granularity);
    if (groupby) params.set("groupby", groupby);
    if (chartType) params.set("chartType", chartType);
    if (selectedGPU && selectedGPU.length < GPU_OPTIONS.length) {
      params.set("gpu", selectedGPU.join(","));
    }
    if (selectedOS && selectedOS.length < OS_OPTIONS.length) {
      params.set("os", selectedOS.join(","));
    }
    if (
      selectedProviders &&
      selectedProviders.length < PROVIDER_OPTIONS.length
    ) {
      params.set("provider", selectedProviders.join(","));
    }

    if (selectedYAxis) params.set("yAxis", selectedYAxis);
    if (searchFilter) params.set("searchFilter", searchFilter);

    router.push({
      pathname: router.pathname,
      query: params.toString(),
    });
  }, [
    startTime,
    stopTime,
    granularity,
    timeRange,
    groupby,
    chartType,
    selectedGPU,
    selectedOS,
    selectedProviders,
    selectedYAxis,
    searchFilter,
    selectedRepos,
  ]);

  const generateTimeSeriesGridItem = (
    groupby: CostCategory,
    yAxis: "cost" | "duration"
  ) => {
    console.log("WORKING WITH repos:", repos);
    return (
      <Grid item xs={8} height={ROW_HEIGHT}>
        {!isLoading && (
          <TimeSeriesPanel
            title={`CI ${yAxis} per ${groupby} per ${granularity}`}
            queryName={`${yAxis}_job_per_${groupby}`}
            queryParams={{
              ...timeParamsClickHouse,
              groupby,
              selectedRepos,
              selectedGPU,
              selectedPlatforms: selectedOS,
              selectedProviders,
            }}
            granularity={granularity}
            groupByFieldName={groupby}
            timeFieldName={"granularity_bucket"}
            yAxisFieldName={`total_${yAxis}`}
            yAxisRenderer={yAxis === "cost" ? costDisplay : hourDisplay}
            useClickHouse={true}
            smooth={false}
            chartType={chartType}
            filter={searchFilter}
            sort_by="total"
            auto_refresh={false}
          />
        )}
        {isLoading && <div>Loading...</div>}
      </Grid>
    );
  };

  const generateGroupByAndFilterBar = () => {
    const marginStyle = {
      marginTop: 20,
    };
    console.log("rendering with selected repos:", selectedRepos);
    return (
      <div>
        <Typography fontSize={"1rem"} fontWeight={"bold"}>
          Dimension
        </Typography>
        <Grid item xs={2} style={marginStyle}>
          <FormControl style={{ width: 195 }}>
            <InputLabel id="y-axis-select-label">Y-Axis</InputLabel>
            <Select
              value={selectedYAxis}
              label="Y-Axis"
              labelId="y-axis-select-label"
              onChange={(e) =>
                setSelectedYAxis(e.target.value as "cost" | "duration")
              }
            >
              <MenuItem value={"cost"}>Cost</MenuItem>
              <MenuItem value={"duration"}>Duration</MenuItem>
            </Select>
          </FormControl>
        </Grid>

        <div style={{ marginTop: 25, marginBottom: 25 }}>
          <hr />
        </div>
        <Typography fontSize={"1rem"} fontWeight={"bold"}>
          Grouping
        </Typography>

        <Grid item xs={2} style={marginStyle}>
          <FormControl style={{ width: 195 }}>
            <InputLabel id="group-by-select-label">Group By</InputLabel>
            <Select
              value={groupby}
              label="Group By"
              labelId="group-by-select-label"
              onChange={(e) => setGroupBy(e.target.value as CostCategory)}
            >
              <MenuItem value={"runner_type"}>Runner Type</MenuItem>
              <MenuItem value={"workflow_name"}>Workflow Name</MenuItem>
              <MenuItem value={"job_name"}>Job Name</MenuItem>
              <MenuItem value={"platform"}>Platform</MenuItem>
              <MenuItem value={"provider"}>Provider</MenuItem>
            </Select>
          </FormControl>
        </Grid>
        {generateFilterBar(groupby, marginStyle)}

        <div style={{ marginTop: 25, marginBottom: 25 }}>
          <hr />
        </div>
        <Typography fontSize={"1rem"} fontWeight={"bold"}>
          Filters
        </Typography>
        <Grid item xs={2} style={marginStyle}>
          <MultiSelectPicker
            selected={selectedRepos}
            setSelected={setSelectedRepos}
            options={repos?.map((d: any) => d.repo)}
            label={"Repositories"}
            renderValue={(selectedItems) => {
              if (selectedItems.length == repos.length) return "All";
              if (selectedItems.length == 0) return "None";

              return selectedItems
                .map((item: string) => item?.split("/")[1])
                .join(",");
            }}
            style={{ width: 195 }}
          />
        </Grid>
        <Grid item xs={2} style={marginStyle}>
          <MultiSelectPicker
            selected={selectedOS}
            setSelected={setSelectedOS}
            options={OS_OPTIONS}
            label={"OS"}
            renderValue={(selectedItems) => {
              if (selectedItems.length == OS_OPTIONS.length) return "All";
              if (selectedItems.length == 0) return "None";
              return selectedItems.join(",");
            }}
            style={{ width: 195 }}
          />
        </Grid>
        <Grid item xs={2} style={marginStyle}>
          <MultiSelectPicker
            selected={selectedProviders}
            setSelected={setSelectedProviders}
            options={PROVIDER_OPTIONS}
            label={"Provider"}
            renderValue={(selectedItems) => {
              if (selectedItems.length == PROVIDER_OPTIONS.length) return "All";
              if (selectedItems.length == 0) return "None";
              return selectedItems.join(",");
            }}
            style={{ width: 195 }}
          />
        </Grid>
        <Grid item xs={1} style={marginStyle}>
          <MultiSelectPicker
            selected={selectedGPU.map((item) =>
              item === 1 ? "gpu" : "non-gpu"
            )}
            setSelected={(selected: string[]) => {
              if (selected.length == 2) {
                setSelectedGPU([0, 1]);
              } else if (selected.length == 0) {
                setSelectedGPU([]);
              } else {
                setSelectedGPU(
                  selected.map((item: string) => (item === "gpu" ? 1 : 0))
                );
              }
            }}
            options={GPU_OPTIONS}
            label={"GPU/Non-GPU"}
            renderValue={(selectedItems) => {
              if (selectedItems.length == GPU_OPTIONS.length) return "All";
              if (selectedItems.length == 0) return "None";
              return selectedItems.join(",");
            }}
            style={{ width: 195 }}
          />
        </Grid>
      </div>
    );
  };

  const generateFilterBar = (type: CostCategory, style = {}) => {
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setTimeout(() => {
        setSearchFilter(() => {
          return value;
        });
      }, 500);
    };

    return (
      <Grid item xs={12} style={style}>
        <TextField
          id={`outlined-basic-${type}`}
          label={
            <div>
              <FaFilter /> Filter {type}
            </div>
          }
          onChange={handleChange}
          variant="outlined"
        />
      </Grid>
    );
  };

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          PyTorch CI Cost & Runtime Analytics
        </Typography>
      </Stack>
      <Grid container spacing={2}>
        <Grid item xs={8}>
          <TimeRangePicker
            startTime={startTime}
            setStartTime={setStartTime}
            stopTime={stopTime}
            setStopTime={setStopTime}
            timeRange={timeRange}
            setTimeRange={setTimeRange}
          />
          <FormControl style={{ marginLeft: 10, minWidth: 100 }}>
            <InputLabel id="granularity-select-label">Granularity</InputLabel>
            <Select
              value={granularity}
              label="Granularity"
              labelId="granularity-select-label"
              onChange={(e) => setGranularity(e.target.value as Granularity)}
            >
              <MenuItem value={"day"}>Daily</MenuItem>
              <MenuItem value={"week"}>Weekly</MenuItem>
              <MenuItem value={"month"}>Monthly</MenuItem>
            </Select>
          </FormControl>
          <FormControl style={{ marginLeft: 10, minWidth: 100 }}>
            <InputLabel
              htmlFor="toggle-button-group"
              shrink
              style={{ marginBottom: 8 }}
            >
              Chart Type
            </InputLabel>
            <FormGroup>
              <ToggleButtonGroup
                exclusive
                value={chartType}
                onChange={(
                  event: React.MouseEvent<HTMLElement>,
                  newChartType: ChartType
                ) => {
                  if (newChartType === null) {
                    return;
                  }
                  setChartType(newChartType);
                  console.log("Selected Chart Type:", newChartType);
                }}
                style={{ height: 56 }}
                aria-label="toggle-button-group"
              >
                <ToggleButton value="stacked_bar">
                  <Tooltip title="Stacked Bar Chart">
                    <Box
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                    >
                      <Image
                        src="/bar-chart.png"
                        alt="stacked bar chart"
                        width={20}
                        height={20}
                      />
                    </Box>
                  </Tooltip>
                </ToggleButton>
                <ToggleButton value="bar">
                  <Tooltip title="Bar Chart">
                    <Box
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                    >
                      <Image
                        src="/bar-graph.png"
                        alt="bar chart"
                        width={20}
                        height={20}
                      />
                    </Box>
                  </Tooltip>
                </ToggleButton>
                <ToggleButton value="line">
                  <Tooltip title="Line Chart">
                    <Box
                      display="flex"
                      alignItems="center"
                      justifyContent="center"
                    >
                      <Image
                        src="/chart.png"
                        alt="line chart"
                        width={20}
                        height={20}
                      />
                    </Box>
                  </Tooltip>
                </ToggleButton>
              </ToggleButtonGroup>
            </FormGroup>
          </FormControl>
        </Grid>
      </Grid>
      <Grid container spacing={2}>
        <Grid container marginTop={4}>
          {generateTimeSeriesGridItem(
            groupby || "workflow_name",
            selectedYAxis || "cost"
          )}
          <Grid item xs={1}></Grid>
          {generateGroupByAndFilterBar()}
        </Grid>
      </Grid>
    </div>
  );
}
