import AnnouncementBanner from "components/AnnouncementBanner";
import NavBar from "components/NavBar";
import SevReport from "components/SevReport";
import type { AppProps } from "next/app";
import Head from "next/head";
import { useRouter } from "next/router";
import { useEffect } from "react";
import "styles/globals.css";
import { pageview } from "../lib/googleAnalytics";

function MyApp({ Component, pageProps }: AppProps) {
  const router = useRouter();

  useEffect(() => {
    const handleRouteChange = (url: string) => {
      console.log("GOING INTO PAGE VIEW");
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
