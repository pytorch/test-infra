import { Button, Drawer } from "@mui/material";
import { useState } from "react";
import { BenchmarkRegressionReportListWrapper } from "./listView/BenchmarkRegressionReportListWrapper";
import { BenchmarkRegressionReportWrapper } from "./reportView/RegressionReportViewWrapper";

export function BenchmarkReportFeatureSidePanel({
  type = "list",
  id = "",
  buttonText = "Regression Report",
  onClose = (data: any) => {},
}: {
  type: "list" | "detail";
  buttonText?: string;
  id?: string;
  onClose?: (data: any) => void;
}) {
  const [open, setOpen] = useState(false);

  if (!id) return null;

  return (
    <>
      {/* trigger */}
      <Button variant="outlined" size="small" onClick={() => setOpen(true)}>
        {buttonText}
      </Button>

      {/* drawer */}
      <Drawer
        anchor="right"
        open={open}
        onClose={() => setOpen(false)}
        sx={{ width: "50vw", height: "100vh" }}
      >
        {type === "list" && (
          <BenchmarkRegressionReportListWrapper report_id={id} limit={5} />
        )}
        {type === "detail" && (
          <BenchmarkRegressionReportWrapper
            id={id}
            enableTableSidePanel={false}
          />
        )}
      </Drawer>
    </>
  );
}
