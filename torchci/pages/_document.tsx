import { Head, Html, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html>
      <Head>
        {/* Preload script to prevent white flash in dark mode */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var themeMode = localStorage.getItem('themeMode');
                  var systemDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
                  var isDarkMode =
                    themeMode === 'dark' ||
                    (themeMode === 'system' && systemDarkMode) ||
                    (!themeMode && systemDarkMode);

                  if (isDarkMode) {
                    document.documentElement.classList.add('dark-mode');
                    document.documentElement.style.backgroundColor = '#1e1e1e';

                    // Create and append a style element to handle navbar and other elements before React loads
                    var style = document.createElement('style');
                    style.id = 'dark-mode-init-styles';
                    style.textContent = \`
                      html, body { background-color: #1e1e1e !important; color: #e0e0e0 !important; }
                      div[class*="navbar"] {
                        background: linear-gradient(326deg, #2a2a2a, #2d2d2d) !important;
                        box-shadow: 0 -4px 20px 0px rgba(0, 0, 0, 0.4) !important;
                      }
                      /* Force all top-level elements to have dark background */
                      #__next, #__next > div {
                        background-color: #1e1e1e !important;
                      }
                    \`;
                    document.head.appendChild(style);
                  }
                } catch (e) {
                  // If localStorage is not available, do nothing
                }
              })();
            `,
          }}
        />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
