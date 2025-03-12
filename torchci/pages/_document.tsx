import { Head, Html, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html>
      <Head>
        {/* This script prevents flash of incorrect theme (FOIT) */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var themeMode = localStorage.getItem('themeMode');
                  var systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

                  if (themeMode === 'dark' || (themeMode === 'system' && systemDark)) {
                    document.documentElement.classList.add('dark-mode');
                  }
                } catch (e) {}
              })();
            `,
          }}
        />
        {/* Custom styles for charts */}
        <link rel="stylesheet" href="/chart-legend.css" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
