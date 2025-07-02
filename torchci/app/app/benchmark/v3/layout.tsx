import { Box } from "@mui/material";
import { ReactNode } from "react";

const drawerWidth = 200;

export default function BenchmarkV3Layout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <Box sx={{ display: "flex" }}>
      {/* Main content */}
      <Box component="main" sx={{ flexGrow: 1, p: 3, ml: `${drawerWidth}px` }}>
        {children}
      </Box>
    </Box>
  );
}
