import { FormControlLabel, Switch, Typography } from "@mui/material";
import { Stack } from "@mui/system";
import { MaxSamplingInput } from "./SamplingInput";
import { useEffect } from "react";

const DEFAULT_MAX_SAMPLING = 1000;

type SamplingSettingProps = {
  enableSamplingSetting?: boolean;
  setEnableSamplingSetting: (v: boolean) => void;
  maxSamplingValue: number;
  setMaxSampling: (v: number) => void;
};

export function SamplingSetting({
  enableSamplingSetting,
  setEnableSamplingSetting,
  maxSamplingValue,
  setMaxSampling,
}: SamplingSettingProps) {

  return (
    <Stack spacing={1}>
      {/* Toggle row */}
      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={enableSamplingSetting?? false}
            onChange={(e) => setEnableSamplingSetting(e.target.checked)}
          />
        }
        label={
          <Typography variant="body2" sx={{ fontWeight: 500 }}>
            Enable Sampling
          </Typography>
        }
      />

      {/* Sampling input */}
      <MaxSamplingInput
        value={maxSamplingValue}
        onChange={setMaxSampling}
        label="Max Sampling"
        info="Maximum benchmark results to return. Use lower values to avoid OOM issues."
        disabled={!enableSamplingSetting} // disables when toggle off
      />
    </Stack>
  );
}
