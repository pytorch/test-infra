import { Button, TextField } from "@mui/material";
import { Stack } from "@mui/system";
import RegexButton from "components/common/RegexButton";
import { formatHudUrlForRoute, packHudParams } from "lib/types";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";

export default function JobFilterInput({
  currentFilter,
  handleSubmit,
  width,
  handleFocus,
}: {
  currentFilter: string | null;
  handleSubmit: (f: any) => void;
  handleFocus?: () => void;
  width?: string;
}) {
  const router = useRouter();
  const params = packHudParams(router.query);
  const [useRegexFilter, setuseRegexFilter] = useState(
    params.useRegexFilter || false
  );

  const [currVal, setCurrVal] = useState<string>(currentFilter ?? "");
  useEffect(() => {
    // something about hydration and states is making it so that currVal remains
    // as "" when currentFilter changes
    setCurrVal(currentFilter ?? "");
  }, [currentFilter]);

  useEffect(() => {
    router.push(
      formatHudUrlForRoute("hud", { ...params, useRegexFilter }),
      undefined,
      {
        shallow: true,
      }
    );
  }, [useRegexFilter]);

  return (
    <div style={{ margin: 0 }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit(currVal);
        }}
      >
        <Stack direction="row" spacing={1} alignItems="center">
          <label htmlFor="name_filter">Job filter:</label>
          <TextField
            id="name_filter"
            name="name_filter"
            variant="outlined"
            size="small"
            value={currVal}
            onChange={(e) => setCurrVal(e.target.value)}
            onFocus={handleFocus}
            slotProps={{
              input: {
                endAdornment: (
                  <RegexButton
                    isRegex={useRegexFilter}
                    setIsRegex={setuseRegexFilter}
                  />
                ),
              },
            }}
          />
          <Button
            size="large"
            style={{
              minWidth: 0,
              textTransform: "none",
              font: "inherit",
              backgroundColor: "transparent",
              borderColor: "transparent",
              color: "inherit",
            }}
            variant="outlined"
            type="submit"
            onClick={() => handleSubmit(currVal)}
          >
            Go
          </Button>
        </Stack>
      </form>
    </div>
  );
}
