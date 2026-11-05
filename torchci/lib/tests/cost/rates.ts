import {
  type CostView,
  factsOf,
  type MachineRunners,
  type PreparedHours,
} from "lib/tests/cost/runnerHours";

// Cost for the cost page, from a rates file the reader adds: a JSON object
// of runner label → $ per runner-hour, optionally wrapped with when the rates
// hold from and how they were made. The file is read in the browser into the
// page's memory: never sent, stored, or put in the URL (whose query HUD's
// analytics record), and reloading the page drops it. The API holds no
// prices, so without a file the page counts runner-hours only.

export interface RatesFile {
  file: string;
  validFrom: string | null;
  basis: string | null;
  rates: Readonly<Record<string, number>>;
  // The rates as the file gave them, before any edits on the page.
  original: Readonly<Record<string, number>>;
}

// A rates file is a few KB; anything far larger is not one.
export const MAX_RATES_BYTES = 1_000_000;

// No runner costs more than this an hour; a larger number is a typo, and
// one near the float limit would make every total infinite.
export const MAX_RATE = 100_000;

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
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
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
    rates,
    original: rates,
  };
}

// The rates with one runner's rate set, or removed with null: an edit on the
// page, held in memory as the file is.
export function withRate(
  rates: RatesFile,
  key: string,
  rate: number | null
): RatesFile {
  const next: Record<string, number> = { ...rates.rates };
  if (rate === null) delete next[key];
  else next[key] = rate;
  return { ...rates, rates: Object.freeze(next) };
}

// The runners whose rate the page's edits changed, added or removed.
export function editedRates(rates: RatesFile): string[] {
  const keys = new Set([
    ...Object.keys(rates.rates),
    ...Object.keys(rates.original),
  ]);
  return Array.from(keys).filter((k) => rates.rates[k] !== rates.original[k]);
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

// The answer in $: each row's runner-hours times its runner's rate, 0
// where the file has none, those hours kept apart as unpriced. The machines
// keep the runner-hours' order and hues, so a file never reorders or
// repaints them.
export function pricedRunnerHours(
  prepared: PreparedHours,
  rates: RatesFile
): PreparedHours {
  const labelRate = prepared.runnerLabels.map((l) => rateOf(rates, l));
  const n = prepared.rowRunnerHours.length;
  const rowHours = new Float64Array(n);
  const rowUnpriced = new Float64Array(n);
  const workflowTotal = new Float64Array(prepared.workflows.length);
  const machineTotal = new Float64Array(prepared.machines.length);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const hours = prepared.rowRunnerHours[i];
    const rate = labelRate[prepared.rowLabel[i]];
    if (rate === null) {
      rowUnpriced[i] = hours;
      continue;
    }
    rowHours[i] = hours * rate;
    workflowTotal[prepared.rowWorkflow[i]] += rowHours[i];
    machineTotal[prepared.rowMachine[i]] += rowHours[i];
    total += rowHours[i];
  }
  return {
    ...prepared,
    unit: "cost",
    rowHours,
    rowUnpriced,
    labelRate,
    total,
    workflowTotal,
    machineTotal,
  };
}

// $ per runner-hour over the runner-hours that have a rate: a machine's, a
// row's or the scope's average; null where none has one.
export function averageRate(
  value: number,
  runnerHours: number,
  unpriced: number
): number | null {
  const priced = runnerHours - unpriced;
  return priced > 0 ? value / priced : null;
}

// Where a row's bar would end at the scope's average $/h: its runner-hours
// with a rate times that average. A bar past its mark costs more per hour
// than the scope does.
export function costMark(view: CostView, owners: readonly string[]): number {
  const sum = (m: Map<string, number>) =>
    owners.reduce((a, o) => a + (m.get(o) ?? 0), 0);
  const scopeRate =
    averageRate(view.scopeTotal, view.scopeRunnerHours, view.scopeUnpriced) ??
    0;
  return (sum(view.ownerRunnerHours) - sum(view.ownerUnpriced)) * scopeRate;
}

// The facts' row in $: the scope's cost, per day and a year, and the share
// of its runner-hours that have a rate.
export function costFacts(
  prepared: PreparedHours,
  view: CostView,
  days: number
) {
  return {
    ...factsOf(prepared, view, days),
    pricedShare: 1 - view.scopeUnpriced / (view.scopeRunnerHours || 1),
  };
}

// The runners a breakdown's runner-hours have no rate for, largest first.
export function missingRunners(
  machines: readonly MachineRunners[]
): { label: string; hours: number }[] {
  const hours = new Map<string, number>();
  for (const m of machines) {
    for (const r of m.runners) {
      if (r.rate === null)
        hours.set(r.label, (hours.get(r.label) ?? 0) + r.hours);
    }
  }
  return Array.from(hours, ([label, h]) => ({ label, hours: h })).sort(
    (a, b) => b.hours - a.hours || a.label.localeCompare(b.label)
  );
}

// How a file covers the window: the runners with hours, how many it prices,
// those it misses largest first, and its entries for runners that did not
// run here.
export function ratesCoverage(prepared: PreparedHours, rates: RatesFile) {
  const hours = new Float64Array(prepared.runnerLabels.length);
  prepared.rowLabel.forEach((l, i) => (hours[l] += prepared.rowRunnerHours[i]));
  const ran = prepared.runnerLabels.filter((_, l) => hours[l] > 0);
  const missing = prepared.runnerLabels
    .map((label, l) => ({ label, hours: hours[l] }))
    .filter((r) => r.hours > 0 && rateOf(rates, r.label) === null)
    .sort((a, b) => b.hours - a.hours);
  const keys = new Set(ran.map(priceKey));
  return {
    runners: ran.length,
    priced: ran.length - missing.length,
    missing,
    unused: Object.keys(rates.rates).filter((k) => !keys.has(k)),
  };
}

// The window's runners a rate can price, largest first: each price key
// with its runner-hours. Jobs asking for more than one label are left out.
export function priceableRunners(prepared: PreparedHours) {
  const hours = new Map<string, number>();
  prepared.rowLabel.forEach((l, i) => {
    const key = priceKey(prepared.runnerLabels[l]);
    if (key !== null && prepared.rowRunnerHours[i] > 0) {
      hours.set(key, (hours.get(key) ?? 0) + prepared.rowRunnerHours[i]);
    }
  });
  return Array.from(hours, ([label, h]) => ({ label, hours: h })).sort(
    (a, b) => b.hours - a.hours || a.label.localeCompare(b.label)
  );
}
