import {
    Box,
    FormControl,
    Grid2,
    InputLabel,
    MenuItem,
    Select,
    Stack,
    TextField,
    Tooltip,
    Typography,
  } from "@mui/material";
  import CopyLink from "components/CopyLink";
  import TimeSeriesPanel, {
    ChartType,
    Granularity,
  } from "components/metrics/panels/TimeSeriesPanel";
  import MultiSelectPicker from "components/MultiSelectPicker";
  import dayjs from "dayjs";
  import { fetcher } from "lib/GeneralUtils";
  import _ from "lodash";
  import { useRouter } from "next/router";
  import React, { useCallback, useEffect, useState } from "react";
  import { BiLineChart } from "react-icons/bi";
  import { FaFilter, FaInfoCircle, FaRegChartBar } from "react-icons/fa";
  import { MdOutlineStackedBarChart } from "react-icons/md";
  import useSWR from "swr";
  import { FcHeatMap } from "react-icons/fc";
import { DateRangePicker } from "components/metrics/pickers/DateRangePicker";
import { TimeGranuityPicker } from "components/metrics/pickers/TimeGranuityPicker";
import ToggleIconPicker, { ToggleIconPickerContent } from "components/metrics/pickers/ToogleIconPicker";

  type CostCategory =
    | "runner_type"
    | "workflow_name"
    | "job_name"
    | "platform"
    | "provider"
    | "repo"
    | "gpu"
    | "owning_account";

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
  const OWNER_OPTIONS = ["linux_foundation", "meta"];

  export default function QueueTimeChart() {
    const router = useRouter();

    const chartToggleList: ToggleIconPickerContent[]= [
        {
            icon: <MdOutlineStackedBarChart  size={"2em"} />,
            tooltipContent:"bar chart",
            value: "bar",
        },
        {
            icon: <FcHeatMap  size={"2em"} />,
            tooltipContent:"heatmap chart",
            value: "heatmap"
        }
    ]

    const { query } = router;

    const initialEndDate = query.endDate
      ? dayjs(query.endDate as string)
      : dayjs();

    const initialStartDate = query.startDate
      ? dayjs(query.startDate as string)
      : query.dateRange
      ? dayjs().subtract(parseInt(query.dateRange as string), "day")
      : dayjs().subtract(7, "day");

    const initialDateRange = query.dateRange
      ? parseInt(query.dateRange as string)
      : query.startDate || query.endDate
      ? -1
      : 7;

    const initialGranularity = query.granularity || "day";
    const initialGroupBy = query.groupby || "workflow_name";
    const initialChartType = query.chartType || "bar";
    const initialSelectedOwners = query.owners
      ? splitString(query.owners)
      : OWNER_OPTIONS;

    const initialSelectedGPU = query.gpu
      ? splitString(query.gpu).map(Number)
      : [0, 1];

    const initialSelectedOS = query.os ? splitString(query.os) : OS_OPTIONS;

    const initialSelectedProviders = query.provider
      ? splitString(query.provider)
      : PROVIDER_OPTIONS;
    const initialSearchFilter = query.searchFilter || "";
    const initialIsRegex = query.isRegex === "true";
    const initialSelectedRepos = query.repos ? splitString(query.repos) : [];

    // State variables
    const [startDate, setStartDate] = useState(initialStartDate);
    const [endDate, setEndDate] = useState(initialEndDate);
    const [selectedRepos, setSelectedRepos] =
      useState<string[]>(initialSelectedRepos);
    const [availableRepos, setAvailableRepos] = useState<string[]>([]);

    const [granularity, setGranularity] = useState<Granularity>(
      initialGranularity as Granularity
    );
    const [dateRange, setDateRange] = useState(initialDateRange);
    const [groupby, setGroupBy] = useState<CostCategory>(
      initialGroupBy as CostCategory
    );
    const [chartType, setChartType] = useState<ChartType>(
      initialChartType as ChartType
    );
    const [selectedGPU, setSelectedGPU] = useState(initialSelectedGPU);
    const [selectedOwners, setSelectedOwners] = useState(initialSelectedOwners);

    const [selectedOS, setSelectedOS] = useState(initialSelectedOS);
    const [selectedProviders, setSelectedProviders] = useState(
      initialSelectedProviders
    );

    const [searchFilter, setSearchFilter] = useState(
      initialSearchFilter as string
    );
    const [isRegex, setIsRegex] = useState(initialIsRegex);

    const [routerReady, setRouterReady] = useState(false);

    if (!routerReady && router.isReady) {
      setRouterReady(true);
      setDateRange(initialDateRange);
      setStartDate(initialStartDate);
      setEndDate(initialEndDate);
      setGranularity(initialGranularity as Granularity);
      setGroupBy(initialGroupBy as CostCategory);
      setChartType(initialChartType as ChartType);
      setSelectedGPU(initialSelectedGPU);
      setSelectedOwners(initialSelectedOwners);
      setSelectedOS(initialSelectedOS);
      setSelectedProviders(initialSelectedProviders);
      setSearchFilter(initialSearchFilter as string);
      setIsRegex(initialIsRegex);
      if (initialSelectedRepos) {
        setSelectedRepos(initialSelectedRepos);
      }
    }

    const timeParamsClickHouse = {
      startTime: startDate.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
      stopTime: endDate.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    };

    const url = `/api/clickhouse/unique_repos_in_runnercost?parameters=${encodeURIComponent(
      JSON.stringify({
        ...timeParamsClickHouse,
      })
    )}`;

    var {
      data: repos,
      error,
      isLoading,
    } = useSWR<{ repo: string }[]>(url, fetcher);

    if (repos && availableRepos.length === 0) {
      const repoList = repos?.map((item) => item.repo) ?? [];
      setAvailableRepos(repoList);

      if (!selectedRepos || selectedRepos.length === 0) {
        // Only set all repos if none are already selected from URL params
        setSelectedRepos(repoList);
      }
    }

    // Update URL params on state change
    useEffect(() => {
      if (!router.isReady) return;

      const params = new URLSearchParams();
      if (dateRange !== -1) {
        params.set("dateRange", dateRange.toString());
      } else if (startDate && endDate) {
        params.set("startDate", startDate.utc().format("YYYY-MM-DD"));
        params.set("endDate", endDate.utc().format("YYYY-MM-DD"));
      } else {
        params.set("dateRange", "7");
      }

      if (granularity) params.set("granularity", granularity);
      if (groupby) params.set("groupby", groupby);
      if (chartType) params.set("chartType", chartType);
      if (selectedOwners && selectedOwners.length < OWNER_OPTIONS.length) {
        params.set("owners", selectedOwners.join(","));
      }

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

      if (searchFilter) params.set("searchFilter", searchFilter);
      if (isRegex) params.set("isRegex", isRegex.toString());
      if (selectedRepos && selectedRepos.length < availableRepos.length) {
        params.set("repos", selectedRepos.join(","));
      }

      router.push({
        pathname: router.pathname,
        query: params.toString(),
      });
    }, [
      startDate,
      endDate,
      granularity,
      dateRange,
      groupby,
      chartType,
      selectedGPU,
      selectedOS,
      selectedProviders,
      selectedOwners,
      searchFilter,
      isRegex,
      selectedRepos,
    ]);

    const generateTimeSeriesGridItem = (
      groupby: CostCategory,
    ) => {
      return (
        <Grid2 size={{ xs: 8 }} height={ROW_HEIGHT}>
          {!isLoading && (
            <TimeSeriesPanel
              title="test"
              queryName={`_job_per_${groupby}`}
              queryParams={{
                ...timeParamsClickHouse,
                groupby,
                selectedRepos,
                selectedGPU,
                selectedOwners,
                selectedPlatforms: selectedOS,
                selectedProviders,
              }}
              granularity={granularity}
              groupByFieldName={groupby}
              timeFieldName={"granularity_bucket"}
              yAxisFieldName={`total`}
              yAxisRenderer={hourDisplay}
              smooth={false}
              chartType={chartType}
              filter={searchFilter}
              isRegex={isRegex}
              timeFieldDisplayFormat="M/D (UTC)"
              sort_by="total"
              auto_refresh={false}
              max_items_in_series={30}
            />
          )}
          {isLoading && <div>Loading...</div>}
        </Grid2>
      );
    };

    const generateGroupByAndFilterBar = () => {
      const marginStyle = {
        marginTop: 20,
      };
      return (
        <Grid2 size={{ xs: 2 }} container columns={2}>
          <Grid2 size={{ xs: 2 }}>
            <Typography fontSize={"1rem"} fontWeight={"bold"}>
              Dimension
            </Typography>
          </Grid2>
          <Grid2 size={{ xs: 2 }}>
            <div style={{ marginTop: 25, marginBottom: 25 }}>
              <hr />
            </div>
            <Typography fontSize={"1rem"} fontWeight={"bold"}>
              Grouping
            </Typography>
          </Grid2>
          <Grid2 size={{ xs: 2 }}>
            <FormControl style={{ width: "100%" }}>
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

                <MenuItem value={"repo"}>Repository</MenuItem>
              </Select>
            </FormControl>
          </Grid2>
          <Grid2 size={{ xs: 2 }}>
            {generateFilterBar(groupby, marginStyle)}
          </Grid2>

          <Grid2 size={{ xs: 2 }}>
            <MultiSelectPicker
              initialSelected={selectedOS}
              onSelectChanged={setSelectedOS}
              options={OS_OPTIONS}
              label={"Platform"}
              renderValue={(selectedItems) => {
                if (selectedItems.length == OS_OPTIONS.length) return "All";
                if (selectedItems.length == 0) return "None";
                return selectedItems.join(",");
              }}
              style={{ width: "100%" }}
            />
          </Grid2>
          <Grid2 size={{ xs: 2 }}>
            <MultiSelectPicker
              initialSelected={selectedProviders}
              onSelectChanged={setSelectedProviders}
              options={PROVIDER_OPTIONS}
              label={"Provider"}
              renderValue={(selectedItems) => {
                if (selectedItems.length == PROVIDER_OPTIONS.length) return "All";
                if (selectedItems.length == 0) return "None";
                return selectedItems.join(",");
              }}
              style={{ width: "100%" }}
            />
          </Grid2>
          <Grid2 size={{ xs: 2 }}>
            <MultiSelectPicker
              initialSelected={selectedOwners}
              onSelectChanged={setSelectedOwners}
              options={OWNER_OPTIONS}
              label={"Owning Account"}
              renderValue={(selectedItems) => {
                if (selectedItems.length == OWNER_OPTIONS.length) return "All";
                if (selectedItems.length == 0) return "None";
                return selectedItems.join(",");
              }}
              style={{ width: "100%" }}
            />
          </Grid2>
          <Grid2 size={{ xs: 2 }}>
            <MultiSelectPicker
              initialSelected={selectedGPU.map((item) =>
                item === 1 ? "gpu" : "non-gpu"
              )}
              onSelectChanged={(selected: string[]) => {
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
              style={{ width: "100%" }}
            />
          </Grid2>
        </Grid2>
      );
    };

    // Create debounced search filter update function - defined once
    const debouncedSetSearchFilter = useCallback(
      _.debounce((value: string) => {
        setSearchFilter(value);
      }, 500),
      [] // Empty dependency array ensures this is created only once
    );

    // Local state for input value to keep input responsive
    const [inputValue, setInputValue] = useState(initialSearchFilter || "");

    // Update inputValue when searchFilter changes from URL/elsewhere
    useEffect(() => {
      setInputValue(searchFilter);
    }, [searchFilter]);

    const generateFilterBar = (type: CostCategory, style = {}) => {
      // Update the local input value immediately for responsiveness
      const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setInputValue(value);
        debouncedSetSearchFilter(value);
      };

      const handleRegexChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setIsRegex(e.target.checked);
      };

      return (
        <Box>
          <TextField
            id={`outlined-basic-${type}`}
            label={
              <div>
                <FaFilter /> Filter {type}
              </div>
            }
            onChange={handleChange}
            variant="outlined"
            fullWidth
            value={inputValue}
            InputProps={{
              endAdornment: (
                <Tooltip
                  title={
                    isRegex
                      ? "Disable regex pattern matching"
                      : "Enable regex pattern matching"
                  }
                >
                  <div
                    style={{ cursor: "pointer" }}
                    onClick={() => setIsRegex(!isRegex)}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: "4px 8px",
                        marginRight: "4px",
                        borderRadius: "4px",
                        fontSize: "0.75rem",
                        fontFamily: "monospace",
                        backgroundColor: isRegex
                          ? "rgba(63, 81, 181, 0.1)"
                          : "transparent",
                        color: isRegex ? "primary.main" : "text.secondary",
                        border: isRegex
                          ? "1px solid rgba(63, 81, 181, 0.5)"
                          : "1px solid transparent",
                        transition: "all 0.2s",
                      }}
                    >
                      .*
                    </div>
                  </div>
                </Tooltip>
              ),
            }}
          />
        </Box>
      );
    };

    // get full url if router is ready
    const fullUrl = routerReady
      ? `${window.location.origin}${router.asPath}`
      : "";
    return (
      <div>
        <Grid2 container spacing={2}>
        <Grid2 size={{ xs: 8 }}>
          <DateRangePicker
            startDate={startDate}
            setStartDate={setStartDate}
            stopDate={endDate}
            setStopDate={setEndDate}
            dateRange={dateRange}
            setDateRange={setDateRange}
            setGranularity={setGranularity}
          />
          <TimeGranuityPicker granularity={granularity} setGranularity={setGranularity} />
          <ToggleIconPicker toggleList={chartToggleList} type ={chartType} setType={setChartType} />
        </Grid2>
        </Grid2>
        <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
          <Typography fontSize={"2rem"} fontWeight={"bold"}>
            PyTorch Queue Time Analysis
          </Typography>
          <Tooltip title="This page gives an estimate of cost and duration of CI jobs.">
            <Typography fontSize={"1rem"} fontWeight={"bold"}>
              <FaInfoCircle />
            </Typography>
          </Tooltip>
          <CopyLink
            textToCopy={fullUrl}
            link={true}
            compressed={false}
            style={{
              fontSize: "1rem",
              borderRadius: 10,
            }}
          />
        </Stack>
        <Grid2 container spacing={2}>
          <Grid2 container marginTop={4} size={{ xs: 12 }}>
            <div> Start</div>
            <Grid2 size={{ xs: 1 }}></Grid2>
            {generateGroupByAndFilterBar()}
          </Grid2>
        </Grid2>
      </div>
    );
  }
