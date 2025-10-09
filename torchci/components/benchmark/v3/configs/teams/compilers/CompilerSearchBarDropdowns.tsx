import {
  COMPILERS_DTYPES_V2,
  DISPLAY_NAMES_TO_ARCH_NAMES,
  DISPLAY_NAMES_TO_DEVICE_NAMES,
} from "components/benchmark/compilers/common";
import { SUITES } from "components/benchmark/compilers/SuitePicker";
import { SingleStringLabelInput } from "components/benchmark/v3/components/benchmarkSideBar/components/SingleStringLabelInput";
import {
  UMDenseDropdown,
  UMDenseModePicker,
} from "components/uiModules/UMDenseComponents";
import { useDashboardSelector } from "lib/benchmark/store/benchmark_dashboard_provider";

export function CompilerSearchBarDropdowns() {
  const { stagedFilters, setStagedFilter } = useDashboardSelector((s) => ({
    stagedFilters: s.stagedFilters,
    setStagedFilter: s.setStagedFilter,
  }));

  return (
    <>
      <UMDenseModePicker
        mode={stagedFilters.mode ?? ""}
        setMode={(val: string) => setStagedFilter("mode", val)}
        setDType={(val: string) => setStagedFilter("dtype", val)}
      />
      <UMDenseDropdown
        dtype={stagedFilters.dtype ?? ""}
        setDType={(val: string) =>
          val === "notset"
            ? setStagedFilter("dtype", "")
            : setStagedFilter("dtype", val)
        }
        dtypes={COMPILERS_DTYPES_V2}
        label="Precision"
      />
      <UMDenseDropdown
        dtype={stagedFilters.deviceName ?? ""}
        setDType={(val: string) => {
          setStagedFilter("deviceName", val);
          setStagedFilter("device", DISPLAY_NAMES_TO_DEVICE_NAMES[val]);
          setStagedFilter("arch", DISPLAY_NAMES_TO_ARCH_NAMES[val]);
        }}
        dtypes={Object.keys(DISPLAY_NAMES_TO_DEVICE_NAMES)}
        label="Device"
      />
      <UMDenseDropdown
        dtype={stagedFilters.suite ?? ""}
        setDType={(val: string) => setStagedFilter("suite", val)}
        dtypes={["all", ...Object.keys(SUITES)]}
        label="Suite"
      />
      <SingleStringLabelInput
        title="Config"
        value={stagedFilters.compiler}
        helperText="Filter by compiler config"
        onChange={(newLabel) => {
          setStagedFilter("compiler", newLabel ?? "all");
        }}
      />
    </>
  );
}
