import { Box, SxProps, Theme, Tooltip } from "@mui/material";
import TokenLine from "components/tests/TokenLine";
import { fitTokens, Token } from "lib/tests/environment";

export interface CountedTokenLineProps {
  tokens: readonly Token[];
  // How many characters of token text the line holds before the rest is
  // counted.
  budget: number;
  // What a token is, for the count's label: "owner", "workflow".
  noun: string;
  onFilter: (_filters: Token["filters"]) => void;
  // The line's own styles: its color and size.
  sx?: SxProps<Theme>;
}

// Tokens on one line, as many as fit a character budget, and the rest
// counted, "+1", in the muted color, with the count listing the rest on
// hover, each by what its text is short for when it is short for something,
// so nothing is cut off. The Owners cell and the Config cell's workflow line
// are both set this way.
export default function CountedTokenLine({
  tokens,
  budget,
  noun,
  onFilter,
  sx,
}: CountedTokenLineProps) {
  const { shown, hidden } = fitTokens(tokens, budget);
  return (
    <Box
      component="span"
      sx={[
        {
          display: "flex",
          alignItems: "baseline",
          minWidth: 0,
          maxWidth: "100%",
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      <TokenLine tokens={shown} onFilter={onFilter} />
      {hidden.length > 0 && (
        <Tooltip
          title={
            <Box component="span" sx={{ display: "block", whiteSpace: "pre" }}>
              {hidden.map((token) => token.tooltip ?? token.text).join("\n")}
            </Box>
          }
          enterDelay={300}
        >
          <Box
            component="span"
            aria-label={`${hidden.length} more ${noun}${
              hidden.length === 1 ? "" : "s"
            }`}
            sx={{
              ml: 0.5,
              whiteSpace: "nowrap",
              color: "text.secondary",
              cursor: "default",
            }}
          >
            +{hidden.length}
          </Box>
        </Tooltip>
      )}
    </Box>
  );
}
