import AnnouncementBanner from "components/AnnouncementBanner";
import NavBar from "components/NavBar";
import SevReport from "components/SevReport";
import { SessionProvider } from "next-auth/react";
import type { AppProps } from "next/app";
import Head from "next/head";
import "styles/globals.css";

function MyApp({ Component, pageProps }: AppProps) {
  return (
    <>
      <SessionProvider>
        <Head>
          <title>PyTorch CI HUD</title>
        </Head>
        <NavBar />
        <AnnouncementBanner />
        <SevReport />
        <div style={{ margin: "20px" }}>
          <Component {...pageProps} />
        </div>
      </SessionProvider>
    </>
  );
}

export default MyApp;
