import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { Button, Drawer, Typography } from "@mui/material";
import { Box, Stack } from "@mui/system";
import Link from "next/link";
import { cloneElement, useState } from "react";
import { BenchmarkRegressionReportListWrapper } from "./listView/BenchmarkRegressionReportListWrapper";
import { BenchmarkRegressionReportWrapper } from "./reportView/RegressionReportViewWrapper";

export function BenchmarkReportFeatureSidePanel({
  type = "list",
  id = "",
  buttonText = "Regression Reports",
  buttonComponent,
  buttonSx,
  onClose = (data: any) => {},
}: {
  type: "list" | "detail";
  buttonText?: string;
  id?: string;
  onClose?: (data: any) => void;
  buttonComponent?: React.ReactElement;
  buttonSx?: any;
}) {
  const [open, setOpen] = useState(false);

  if (!id) return null;

  // Define handler once
  const handleOpen = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation?.();
    setOpen(true);
  };

  const trigger = buttonComponent ? (
    cloneElement(buttonComponent, {
      onClick: (e: any) => {
        buttonComponent.props.onClick?.(e);
        handleOpen(e);
      },
    })
  ) : (
    <Button variant="outlined" size="small" sx={buttonSx} onClick={handleOpen}>
      {buttonText}
    </Button>
  );
  return (
    <>
      {/* trigger */}
      {trigger}
      {/* drawer */}
      <Drawer
        anchor="right"
        open={open}
        onClose={() => setOpen(false)}
        sx={{ width: "40vw", height: "100vh", maxWidth: "1000px" }}
      >
        <Box sx={{ width: "40vw" }}>
          {type === "list" && (
            <BenchmarkRegressionReportListWrapper report_id={id} limit={5} />
          )}
          {type === "detail" && (
            <>
              <Box
                color="primary"
                sx={{
                  bx: 1,
                  px: 1,
                }}
              >
                <Button>
                  <Link
                    href={`/benchmark/regression/report/${id}`}
                    style={{ textDecoration: "none" }}
                  >
                    <Stack direction="row" alignItems="center" spacing={0.5}>
                      <Typography variant="body2" color="primary">
                        Go to full report page
                      </Typography>
                      <ChevronRightIcon fontSize="small" />
                    </Stack>
                  </Link>
                </Button>
              </Box>
              <BenchmarkRegressionReportWrapper
                id={id}
                enableTableSidePanel={false}
                chartSizeSx={{ sx: 12, lg: 12 }}
              />
            </>
          )}
        </Box>
      </Drawer>
    </>
  );
}
