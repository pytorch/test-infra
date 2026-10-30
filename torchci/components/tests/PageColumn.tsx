import { Stack } from "@mui/material";
import { PAGE_PADDING, TESTS_TABLE_WIDTH } from "lib/tests/layout";
import type { ReactNode } from "react";

// The column the test hub's pages are set in: one fixed-width column,
// centered, so the table does not stretch with the window. It is as wide as
// the tests table with every column at its width, so at full width the
// table is whole, not scrolled sideways, and a page without the table keeps
// the same measure. Its children are stacked with the pages' shared spacing.
export default function PageColumn({ children }: { children: ReactNode }) {
  return (
    <Stack
      spacing={3}
      sx={{
        p: PAGE_PADDING,
        maxWidth: (theme) =>
          `calc(${TESTS_TABLE_WIDTH}px + ${theme.spacing(2 * PAGE_PADDING)})`,
        mx: "auto",
      }}
    >
      {children}
    </Stack>
  );
}
