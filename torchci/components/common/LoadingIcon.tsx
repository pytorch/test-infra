import { CircularProgress } from "@mui/material";
import { Stack } from "@mui/system";

type CenteredLoaderProps = {
  size?: number;
  thickness?: number;
  minHeight?: number | string;
};

export function CenteredLoader({
  size = 20,
  thickness = 4,
  minHeight = 80,
}: CenteredLoaderProps) {
  return (
    <Stack
      alignItems="center"
      justifyContent="center"
      sx={{ height: "100%", minHeight }}
    >
      <CircularProgress size={size} thickness={thickness} />
    </Stack>
  );
}
