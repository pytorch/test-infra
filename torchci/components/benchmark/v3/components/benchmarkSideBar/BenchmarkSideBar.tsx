import { Divider, Typography } from "@mui/material";
import { Box } from "@mui/system";
import { CommitWorflowSelectSection } from "./components/CommitWorkfowSelectSection";
import { SideBarMainSection } from "./components/SideBarMainSection";

const styles = {
  Sidebar: {
    minWidth: "250px",
    width: {
      md: "300px", // medium
      lg: "400px ", // large and up
    },
    position: "sticky",
    top: 0,
    alignSelf: "flex-start",
    height: "100vh",
    overflowY: "auto",
    m: 1, // margin: theme.spacing(1) (≈8px)
    p: 2, // padding: theme.spacing(1) (≈8px)
    borderRight: "1px solid",
    borderColor: "divider",
  },
};
export default function BenchmarkSideBar() {
  return (
    <Box component="aside" sx={styles.Sidebar}>
      <Typography variant="h6">Search</Typography>
      <SideBarMainSection />
      <Divider />
      <CommitWorflowSelectSection />
    </Box>
  );
}
