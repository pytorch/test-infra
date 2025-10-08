import { Badge, IconButton, Tooltip } from "@mui/material";
import { Box } from "@mui/system";
import dayjs from "dayjs";
import { useListBenchmarkRegressionReportsData } from "lib/benchmark/api_helper/apis/hooks";
import { RiNotification2Fill } from "react-icons/ri";
import { BenchmarkReportFeatureSidePanel } from "./BenchmarkReportFeatureSidePanel";
import {
  BenchmarkNotificationColor,
  BenchmarkRegressionReport,
} from "./common";

const CHECK_EVERY_FOUR_HOUR = 4 * 60 * 60 * 1000;

export function BenchmarkReportFeatureNotification({
  report_id,
  refresh_interval = CHECK_EVERY_FOUR_HOUR,
  durationReportMissingReport = 3,
}: {
  report_id: string;
  refresh_interval?: number;
  durationReportMissingReport?: number;
}) {
  const { data, isLoading, error } = useListBenchmarkRegressionReportsData(
    report_id,
    3,
    refresh_interval
  );

  if (error) {
    return <Box>Error: {error.message}</Box>;
  }

  if (isLoading) {
    return <></>;
  }

  let info = checkRegressionReportNotification(
    data,
    report_id,
    durationReportMissingReport
  );

  return (
    <FloatingIcon
      report_id={report_id}
      id={info.id}
      type={info.type}
      content={info.content}
      badgeContent={info.badgeContent}
      enable={info.enable}
    />
  );
}

function checkRegressionReportNotification(
  resp: any,
  report_id: string,
  durationReportMissingReport: number
): Record<string, any> {
  if (!resp || resp?.reports?.length === 0) {
    return <></>;
  }

  // get latest report from response
  const report = resp.reports[2] as BenchmarkRegressionReport;
  const createdDate = dayjs(report?.created_at);
  const now = dayjs();

  const defaultRes = {
    enable: false,
    id: report.id,
    report_id,
  };
  // check if missing generated report for past x days, if so pop up warning icon
  if (createdDate.isBefore(now.subtract(durationReportMissingReport, "day"))) {
    // return warning notification color icon
    return {
      ...defaultRes,
      content: `Warning: we haven't detected the report generated in x days, lastest report is generated at ${createdDate.toLocaleString()}`,
      type: "warning",
      badgeContent: "undetected",
      enable: true,
    };
  }

  if (report.status === "regression") {
    // return regression notification color icon
    return {
      ...defaultRes,
      type: "error",
      enable: true,
      content: `We found Regression detected in latest report, please click this alert for more details`,
      badgeContent: "Regression",
      id: report.id,
      report_id,
    };
  }

  if (report.status === "suspicious") {
    return {
      ...defaultRes,
      type: "warning",
      enable: true,
      id: report.id,
      badgeContent: "Suspicious",
      content: `We found Suspicious detected in latest report, please check it for more details`,
      report_id,
    };
  }

  return defaultRes;
}

export function FloatingIcon({
  report_id,
  id,
  type = "default",
  content = "",
  badgeContent = "",
  enable = false,
}: {
  report_id?: string;
  id?: string;
  type?: string;
  content?: string;
  badgeContent?: string;
  enable?: boolean;
}) {
  let color = "default";
  if (type) {
    color = BenchmarkNotificationColor[type] ?? "default";
  }

  if (!enable) {
    return <></>;
  }

  return (
    <>
      <BenchmarkReportFeatureSidePanel
        id={id}
        type="detail"
        buttonComponent={
          <RegressionNotificationButton
            color={color}
            content={content}
            badgeContent={badgeContent}
          />
        }
      />
    </>
  );
}

function RegressionNotificationButton({
  color,
  content,
  badgeContent = "",
  onClick,
}: {
  color: string;
  content: string;
  badgeContent?: string;
  onClick?: React.MouseEventHandler<HTMLElement>;
}) {
  return (
    <Tooltip title={content}>
      <span onClick={onClick}>
        <Badge
          badgeContent={badgeContent}
          sx={{
            "& .MuiBadge-badge": {
              backgroundColor: color,
              color: "white",
            },
          }}
          overlap="circular"
          badgeContent={"!"}
        >
          <IconButton sx={{ color }}>
            <RiNotification2Fill />
          </IconButton>
        </Badge>
      </span>
    </Tooltip>
  );
}
