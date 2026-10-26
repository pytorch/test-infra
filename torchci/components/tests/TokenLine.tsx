import { Box, SxProps, Theme } from "@mui/material";
import FilterToken from "components/tests/FilterToken";
import type { Token } from "lib/tests/environment";
import { Fragment } from "react";

export interface TokenLineProps {
  tokens: Token[];
  onFilter: (_filters: Token["filters"]) => void;
  sx?: SxProps<Theme>;
}

// Tokens on one line, separated by a muted middle dot, cut off with an
// ellipsis at the cell's edge; the cell's tooltip holds the whole.
export default function TokenLine({ tokens, onFilter, sx }: TokenLineProps) {
  return (
    <Box
      component="span"
      sx={{
        display: "block",
        maxWidth: "100%",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        ...sx,
      }}
    >
      {tokens.map((token, index) => (
        <Fragment key={index}>
          {index > 0 && (
            <Box component="span" sx={{ color: "text.disabled", mx: 0.5 }}>
              ·
            </Box>
          )}
          <FilterToken token={token} onFilter={onFilter} />
        </Fragment>
      ))}
    </Box>
  );
}
