import {
  COMPILERS_DTYPES_V2,
  DISPLAY_NAMES_TO_ARCH_NAMES,
  DISPLAY_NAMES_TO_DEVICE_NAMES,
} from "components/benchmark/compilers/common";
import { SUITES } from "components/benchmark/compilers/SuitePicker";
import { SingleStringLabelInput } from "components/benchmark_v3/components/benchmarkSideBar/components/filters/SingleStringLabelInput";
import {
  UMDenseDropdown,
  UMDenseModePicker,
} from "components/uiModules/UMDenseComponents";
import { useDashboardSelector } from "lib/benchmark/store/benchmark_dashboard_provider";
import { BenchmarkPageType } from "../../config_book_types";
export function CompilerSearchBarDropdowns() {
  const backendFilterInfo =
    "The displayed data is post-sampling and may not include all entries. For non-continuous data, commit options are based on the sampled set, so use the chart or table interactions to explore complete results";

  const { stagedFilters, setStagedFilter, type } = useDashboardSelector(
    (s) => ({
      stagedFilters: s.stagedFilters,
      setStagedFilter: s.setStagedFilter,
      type: s.type,
    })
  );

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
          setStagedFilter("device", DISPLAY_NAMES_TO_DEVICE_NAMES[val][0]);
          setStagedFilter("arch", DISPLAY_NAMES_TO_ARCH_NAMES[val][0]);
        }}
        dtypes={Object.keys(DISPLAY_NAMES_TO_DEVICE_NAMES)}
        label="Device"
      />
      <UMDenseDropdown
        dtype={stagedFilters.suite ?? "all"}
        setDType={(val: string) => setStagedFilter("suite", val)}
        dtypes={["all", ...Object.keys(SUITES)]}
        label="Suite"
      />
      {type != BenchmarkPageType.AggregatePage && (
        <SingleStringLabelInput
          title="Model"
          value={stagedFilters.model}
          helperText="filter model, e.g. dlrm"
          onChange={(newLabel) => {
            setStagedFilter("model", newLabel ?? "all");
          }}
        />
      )}
      <SingleStringLabelInput
        title="Backend"
        value={stagedFilters.compiler}
        helperText="filter backend, e.g. aot_eager"
        info={backendFilterInfo}
        onChange={(newLabel) => {
          setStagedFilter("compiler", newLabel ?? "all");
        }}
      />
    </>
  );
}
