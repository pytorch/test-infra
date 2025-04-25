import Head from "next/head";
import React from "react";
import { useDarkMode } from "../lib/DarkModeContext";

const JobCancellationDashboard: React.FC = () => {
  const { themeMode, darkMode } = useDarkMode();

  // Set theme parameter based on dark mode context
  let theme = "light";
  if (themeMode === "system") {
    theme = darkMode ? "dark" : "light";
  } else {
    theme = themeMode;
  }

  const dashboardUrl = `https://disz2yd9jqnwc.cloudfront.net/public-dashboards/c540578db0b741168e1a94e80e21f6f7?theme=${theme}`;

  return (
    <>
      <Head>
        <title>Job Cancellation Dashboard</title>
      </Head>
      <div
        style={{
          width: "100%",
          height: "calc(100vh - 60px)",
          overflow: "hidden",
        }}
      >
        <iframe
          src={dashboardUrl}
          width="100%"
          height="100%"
          frameBorder="0"
          allowTransparency={true}
        />
      </div>
    </>
  );
};

export default JobCancellationDashboard;
