import {
  COMPILERS_DTYPES_V2,
  DISPLAY_NAMES_TO_DEVICE_NAMES,
} from "components/benchmark/compilers/common";
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
        setDType={(val: string) => setStagedFilter("deviceName", val)}
        dtypes={Object.keys(DISPLAY_NAMES_TO_DEVICE_NAMES)}
        label="Device"
      />
    </>
  );
}
