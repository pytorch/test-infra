import "styles/globals.css";
import type { AppProps } from "next/app";
import Head from "next/head";
import SevReport from "components/SevReport";

function MyApp({ Component, pageProps }: AppProps) {
  return (
    <>
      <Head>
        <title>PyTorch CI HUD</title>
      </Head>
      <SevReport />
      <Component {...pageProps} />
    </>
  );
}

export default MyApp;
