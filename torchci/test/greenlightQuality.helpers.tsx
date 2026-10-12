// Markup readers, themes, fixtures and an SWR stand-in shared by the GreenLight
// Quality tests.
//
// Nothing here may import a module that imports swr: the tests' swr mock
// delegates to useSWRStub below, and a cycle through it would hand a component
// the mock before it exists.

import { createTheme, Theme, ThemeProvider } from "@mui/material";
import { decomposeColor } from "@mui/material/styles";
import fs from "fs";
import { GREENLIGHT_STATUS_LAND } from "lib/greenlight/greenlightRender";
import type { ChartBucket } from "lib/greenlight/qualityCharts";
import { MERGED_VERSION_APPROVED } from "lib/greenlight/qualityFigures";
import path from "path";
import { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ROOT } from "./greenlightQualityColumnSync.helpers";

// Emotion writes a <style> element beside each node it styles on a server
// render. The markup readers drop them; cssOf reads them alone.
export const STYLE_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/g;
const TAG_RE = /<([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const ENTITY_RE = /&(?:amp|lt|gt|quot|#x27);/g;
const ENTITIES: { [_entity: string]: string } = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
};

export function decoded(text: string): string {
  return text.replace(ENTITY_RE, (entity) => ENTITIES[entity]);
}

export function tags(markup: string): { name: string; attributes: string }[] {
  return Array.from(markup.replace(STYLE_RE, "").matchAll(TAG_RE), (match) => ({
    name: match[1],
    attributes: match[2],
  }));
}

export function attribute(
  attributes: string,
  name: string
): string | undefined {
  const value = attributes.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
  return value === undefined ? undefined : decoded(value);
}

// The rules emotion emitted for an element's own class: the CSS a browser gets.
export function cssOf(markup: string, attributes: string): string {
  const className = attributes.match(/css-[A-Za-z0-9-]+/)?.[0];
  return Array.from(markup.matchAll(STYLE_RE), (match) => match[1])
    .filter((rules) => rules.startsWith(`.${className}{`))
    .join("");
}

// The text nodes a reader sees, in order.
export function texts(markup: string): string[] {
  return markup
    .replace(STYLE_RE, "")
    .split(/<[^>]*>/)
    .map(decoded)
    .filter((text) => text !== "");
}

export function ariaLabels(markup: string): string[] {
  return tags(markup).flatMap((tag) => {
    const label = attribute(tag.attributes, "aria-label");
    return label === undefined ? [] : [label];
  });
}

export type ThemeMode = "light" | "dark";

// The dark theme styles/MuiThemeOverrides.tsx gives the app, whose palette the
// charts are drawn against. Its hook builds that theme in an effect, which no
// server render reaches, so the dark palette literal is read out of the file
// and handed to createTheme as the hook hands it.
function appDarkTheme(): Theme {
  const src = fs.readFileSync(
    path.join(ROOT, "styles/MuiThemeOverrides.tsx"),
    "utf8"
  );
  const open = src.indexOf("{", src.indexOf("?", src.indexOf("...(darkMode")));
  let depth = 0;
  let close = open;
  do {
    depth += src[close] === "{" ? 1 : src[close] === "}" ? -1 : 0;
    close += 1;
  } while (depth > 0 && close < src.length);
  const palette = new Function(`return (${src.slice(open, close)});`)();
  if (typeof palette?.background?.paper !== "string") {
    throw new Error(
      "styles/MuiThemeOverrides.tsx: no dark palette literal found. The theme " +
        "moved or changed shape; re-target this reader at it."
    );
  }
  return createTheme({ palette: { mode: "dark", ...palette } });
}

// The app's own palettes: its light theme is MUI's default.
export const THEMES: Record<ThemeMode, Theme> = {
  light: createTheme({ palette: { mode: "light" } }),
  dark: appDarkTheme(),
};

export function rgbOf(colour: string): number[] {
  return decomposeColor(colour).values.slice(0, 3);
}

// A colour as it lands on an opaque background.
export function composite(colour: string, background: string): string {
  const [r, g, b, a = 1] = decomposeColor(colour).values;
  const under = rgbOf(background);
  const mix = (value: number, i: number) =>
    Math.round(value * a + under[i] * (1 - a));
  return `rgb(${mix(r, 0)}, ${mix(g, 1)}, ${mix(b, 2)})`;
}

export function renderThemed(node: ReactNode, mode: ThemeMode): string {
  return renderToStaticMarkup(
    <ThemeProvider theme={THEMES[mode]}>{node}</ThemeProvider>
  );
}

export function tileKeyed<T extends { key: string }>(
  tiles: T[],
  key: string
): T {
  const tile = tiles.find((candidate) => candidate.key === key);
  if (tile === undefined) {
    throw new Error(`no tile keyed ${key}`);
  }
  return tile;
}

export const WINDOW_PROPS = {
  startTime: "2026-07-31T00:00:00.000",
  stopTime: "2026-08-13T00:00:00.000",
  shadowMode: "all" as const,
  autoRefresh: false,
};

// The ledger's first row, a Friday evening, to a Wednesday afternoon: both edges
// fall inside a day and inside an ISO week.
export const WINDOW = {
  effective_start: "2026-07-31T19:35:59.404Z",
  effective_end: "2026-08-12T14:00:00.000Z",
};

// Opens mid-morning, closes on a midnight.
export const SHORT_WINDOW = {
  effective_start: "2026-09-10T08:00:00.000Z",
  effective_end: "2026-09-13T00:00:00.000Z",
};

// A Custom range ending before the ledger begins, whose start the clamp moves
// past its end.
export const INVERTED_WINDOW = {
  effective_start: "2026-07-31T19:35:59.404Z",
  effective_end: "2025-02-01T00:00:00.000Z",
};

const DAY_MS = 24 * 60 * 60 * 1000;

// Consecutive UTC dates computed without dayjs, so an expectation does not share
// the date handling it checks.
export function utcDays(first: string, count: number, stepDays = 1): string[] {
  const start = Date.parse(`${first}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, i) =>
    new Date(start + i * stepDays * DAY_MS).toISOString().slice(0, 10)
  );
}

export function span(bucket: ChartBucket): [string, string] {
  return [bucket.start.toISOString(), bucket.end.toISOString()];
}

// A greenlight_quality_reverts row. counts_in_rate follows the query's rule, so
// a fixture cannot claim a revert the rate would not count: a LAND revert of a
// resolved PR, whose merged version is not stale and whose reverter did not
// classify it ghfirst.
let revertSequence = 0;
export function revert(
  name: string,
  verdict: string,
  mergedVersion: string,
  classification = "nosignal",
  revertedAt?: string
) {
  revertSequence += 1;
  const pr_number = 198000 + revertSequence;
  return {
    pr_number,
    revert_sha: name,
    reverted_at:
      revertedAt ??
      `2026-08-${String(1 + (revertSequence % 11)).padStart(
        2,
        "0"
      )}T12:00:00.000Z`,
    verdict,
    merged_version_approved: mergedVersion,
    revert_classification: classification,
    counts_in_rate:
      verdict === GREENLIGHT_STATUS_LAND &&
      mergedVersion !== MERGED_VERSION_APPROVED.no &&
      classification !== "ghfirst"
        ? 1
        : 0,
  };
}

// The row a revert-free window comes back with, so its totals have a row to ride
// on.
export const ANCHOR = {
  pr_number: 0,
  revert_sha: "",
  reverted_at: null,
  verdict: "",
  merged_version_approved: MERGED_VERSION_APPROVED.unknown,
  revert_classification: "",
  counts_in_rate: 0,
};

// The query's window totals ride on every row it returns, the anchor included.
export function withTotals(rows: any[], totals: { [_column: string]: number }) {
  return rows.map((row) => ({ evaluated_prs_total: 40, ...totals, ...row }));
}

export function shas(rows: any[]): string[] {
  return rows.map((row) => row.revert_sha);
}

export interface SwrCall {
  key: string | null;
  fetcher: unknown;
  options: { [_option: string]: unknown };
}

// What the stub answers with, by key, and every call it took.
export const swrStub = {
  calls: [] as SwrCall[],
  data: new Map<string, unknown>(),
  errors: new Map<string, unknown>(),
  reset() {
    this.calls.length = 0;
    this.data.clear();
    this.errors.clear();
  },
};

export function useSWRStub(
  key: string | null,
  fetcher: unknown,
  options: { [_option: string]: unknown }
) {
  swrStub.calls.push({ key, fetcher, options });
  return key === null
    ? { data: undefined, error: undefined }
    : { data: swrStub.data.get(key), error: swrStub.errors.get(key) };
}
