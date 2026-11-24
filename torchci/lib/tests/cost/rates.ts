// Cost for the cost page, from a rates file the reader adds: a JSON object
// of runner label → $ per runner-hour, optionally wrapped with when the rates
// hold from, the days of usage they were made from and how they were made.
// The file is read in the browser into the page's memory: never sent, stored,
// or put in the URL (whose query HUD's analytics record), and reloading the
// page drops it. The API holds no prices, so without a file the page counts
// runner-hours only.

// The internal rates file, an fburl that opens only for Meta employees: a
// link the reader's browser follows to download it; HUD never fetches it.
export const RATES_FILE_URL = "https://fburl.com/pytorch-ci-rates";

export interface RatesFile {
  file: string;
  validFrom: string | null;
  basis: string | null;
  // The UTC days of runner usage the rates were made from, both included.
  window: { start: string; end: string } | null;
  rates: Readonly<Record<string, number>>;
}

// No runner costs more than this an hour; a larger number is a typo, and
// one near the float limit would make every total infinite.
export const MAX_RATE = 100_000;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// A "YYYY-MM-DD" day on the calendar from year 1: 2028-02-29, not
// 2026-02-30 or 2026-13-01. Read as UTC, so no time zone moves it.
function isDay(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const ms = Date.parse(`${v}T00:00:00Z`);
  return (
    !v.startsWith("0000") &&
    !Number.isNaN(ms) &&
    new Date(ms).toISOString().startsWith(v)
  );
}

// A file's usage window: its first and last days, in order. Anything else
// is ignored, as a note is, so a file with a bad window still prices.
function usageWindow(v: unknown): RatesFile["window"] {
  return isObject(v) && isDay(v.start) && isDay(v.end) && v.start <= v.end
    ? { start: v.start, end: v.end }
    : null;
}

// The file's rates, or an error saying what is wrong with it in a sentence.
export function parseRates(text: string, file: string): RatesFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `${file} is not valid JSON (${e instanceof Error ? e.message : e}).`
    );
  }
  if (!isObject(json)) {
    throw new Error(
      'Expected a JSON object: {"runner label": $/h, …} or {"rates": {…}}.'
    );
  }
  const wrapped = isObject(json.rates);
  const map = wrapped ? (json.rates as Record<string, unknown>) : json;
  const bad = Object.entries(map)
    .filter(
      ([, v]) =>
        typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_RATE
    )
    .map(([k, v]) => `${k} is ${JSON.stringify(v)}`);
  if (bad.length > 0) {
    throw new Error(
      `Rates must be numbers from 0 to 100,000, like 1.23: ${bad
        .slice(0, 3)
        .join("; ")}${bad.length > 3 ? `; and ${bad.length - 3} more` : ""}.`
    );
  }
  if (Object.keys(map).length === 0) throw new Error(`${file} has no rates.`);
  const note = (v: unknown) => (wrapped && typeof v === "string" ? v : null);
  const rates = Object.freeze({ ...(map as Record<string, number>) });
  return {
    file,
    validFrom: note(json.valid_from),
    basis: note(json.basis),
    window: wrapped ? usageWindow(json.window) : null,
    rates,
  };
}

// A row's price key: its runner labels without self-hosted, when one is
// left. Jobs asking for more than one label have no single rate.
export function priceKey(label: string): string | null {
  const labels = label.split(",").filter((l) => l !== "self-hosted");
  return labels.length === 1 ? labels[0] : null;
}

// A runner's $ per runner-hour; null when the file has none. 0 is a price.
export function rateOf(rates: RatesFile, label: string): number | null {
  const key = priceKey(label);
  return key !== null && Object.hasOwn(rates.rates, key)
    ? rates.rates[key]
    : null;
}
