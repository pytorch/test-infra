import AnnouncementBanner from "components/AnnouncementBanner";
import NavBar from "components/NavBar";
import SevReport from "components/SevReport";
import type { AppProps, NextWebVitalsMetric } from "next/app";
import Head from "next/head";
import { useRouter } from "next/router";
import { useEffect } from "react";
import "styles/globals.css";
import { pageview, event } from "../lib/googleAnalytics";

export function reportWebVitals(metric: NextWebVitalsMetric) {
  // @ts-ignore
  window.gtag("event", metric.name, {
    event_category:
      metric.label === "web-vital" ? "Web Vitals" : "Next.js custom metric",
    value: Math.round(
      metric.name === "CLS" ? metric.value * 1000 : metric.value
    ), // values must be integers
    event_label: metric.id, // id unique to current page load
    non_interaction: true, // avoids affecting bounce rate.
  });
}

function MyApp({ Component, pageProps }: AppProps) {
  const router = useRouter();

  useEffect(() => {
    const handleRouteChange = (url: string) => {
      pageview(url);
    };
    //When the component is mounted, subscribe to router changes
    //and log those page views
    router.events.on("routeChangeComplete", handleRouteChange);

    // If the component is unmounted, unsubscribe
    // from the event with the `off` method
    return () => {
      router.events.off("routeChangeComplete", handleRouteChange);
    };
  }, [router.events]);

  return (
    <>
      <Head>
        <title>PyTorch CI HUD</title>
      </Head>
      <NavBar />
      <AnnouncementBanner />
      <SevReport />
      <div style={{ margin: "20px" }}>
        <Component {...pageProps} />
      </div>
    </>
  );
}

export default MyApp;
