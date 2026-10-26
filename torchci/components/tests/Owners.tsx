import { Box } from "@mui/material";
import CountedTokenLine from "components/tests/CountedTokenLine";
import { OWNER_LINE_BUDGET, ownerTokens, Token } from "lib/tests/environment";

export interface OwnersProps {
  // The owner labels of the test's file; empty when it has none.
  owners: readonly string[];
  onFilter: (_filters: Token["filters"]) => void;
}

// Who owns the test's file: its labels on one line, "nn", each filtering on
// click; a muted dash when the file has none. More labels than the line
// holds are counted, "+1", and listed on hover, so nothing is cut off
// (CountedTokenLine, which the Config cell's workflow line shares).
export default function Owners({ owners, onFilter }: OwnersProps) {
  if (owners.length === 0) {
    return (
      <Box component="span" sx={{ color: "text.secondary" }}>
        —
      </Box>
    );
  }
  return (
    <CountedTokenLine
      tokens={ownerTokens(owners)}
      budget={OWNER_LINE_BUDGET}
      noun="owner"
      onFilter={onFilter}
      sx={{ color: "text.primary" }}
    />
  );
}
