import { Box, Tooltip } from "@mui/material";
import DetailList from "components/tests/DetailList";
import TokenLine from "components/tests/TokenLine";
import type { EnvironmentRecord } from "lib/api/tests/types";
import {
  environmentDetails,
  environmentTokens,
  Token,
} from "lib/tests/environment";
import type { FacetOptions } from "lib/tests/facets";

export interface EnvironmentProps {
  environment: EnvironmentRecord | null;
  // The options, for the labels; the catalog's spelling without them.
  options: FacetOptions | undefined;
  onFilter: (_filters: Token["filters"]) => void;
  // The row above shows the same environment and the table is sorted by it:
  // set softer, so the first row of each run stands out.
  repeated?: boolean;
}

// An environment in two lines and two voices: full strength, what torch was
// built for and the device it ran on, "CUDA 13.2 · NVIDIA H100 80GB HBM3
// ×4"; muted and smaller beneath, the Python and the platform, "Python 3.11
// · Linux 22.04 · x86_64 avx2 · GCC 11.4". Every token filters on click. The
// tooltip lists all eleven fields as the catalog records them.
export default function Environment({
  environment,
  options,
  onFilter,
  repeated = false,
}: EnvironmentProps) {
  if (environment === null) {
    return (
      <Box component="span" sx={{ color: "text.secondary" }}>
        unknown environment
      </Box>
    );
  }
  const { primary, secondary } = environmentTokens(environment, options);
  return (
    <Tooltip
      enterDelay={600}
      placement="bottom-start"
      title={<DetailList details={environmentDetails(environment)} />}
    >
      <Box
        component="span"
        sx={{
          display: "inline-flex",
          flexDirection: "column",
          alignItems: "flex-start",
          minWidth: 0,
          maxWidth: "100%",
          lineHeight: 1.25,
        }}
      >
        <TokenLine
          tokens={primary}
          onFilter={onFilter}
          sx={{ color: repeated ? "text.secondary" : "text.primary" }}
        />
        <TokenLine
          tokens={secondary}
          onFilter={onFilter}
          sx={{
            fontSize: (theme) => theme.typography.caption.fontSize,
            color: repeated ? "text.disabled" : "text.secondary",
          }}
        />
      </Box>
    </Tooltip>
  );
}
