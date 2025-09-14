import {
  COMPILERS_DTYPES_V2,
  DISPLAY_NAMES_TO_DEVICE_NAMES,
} from "components/benchmark/compilers/common";
import {
  UMDenseDropdown,
  UMDenseModePicker,
} from "components/uiModules/UMDenseComponents";
import { useDashboardStore } from "lib/benchmark/store/benchmark_dashboard_provider";

export function CompilerSearchBarDropdowns() {
  const useStore = useDashboardStore();
  const stagedFilters = useStore((s) => s.stagedFilters);
  const setStagedFilter = useStore((s) => s.setStagedFilter);
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
