import {
  addDays,
  type Day,
  type DayRange,
  daysIn,
  type PieceRate,
  type Pricer,
  type RateDayKind,
  type RatePeriod,
  type RateSegment,
  type RatesSet,
} from "lib/api/tests/cost/contracts";
import { hoursLabel } from "lib/tests/cost/query";
import { MAX_RATE, parseRates, priceKey } from "lib/tests/cost/rates";

// Rates that change over time, read in the browser only: a
// rates.json of periods, {basis, periods: [{valid_from, valid_through, rates}]},
// both days included, plus an optional rates.meta.json, {generated_at,
// periods: [{valid_from, status, window}]}. Today's single-set files (a bare
// map, or {valid_from, basis, window, rates}) still load, as one set for
// every day. Each UTC day is priced by the period covering it, never
// averaged across periods; a day in no period stays unpriced, except the
// current slot (the one holding yesterday), which borrows the file's last
// period, marked ≈. A period may carry totals too (PeriodTotals). Nothing
// here is sent, stored or put in a URL.

// A period's optional totals, $ over its days on the rates' basis: the
// whole AWS bill (aws_total, required in totals) and, of it, the instances
// runners run on, up time outside jobs included (runner_nodes). The banner
// prorates them per day, as the rates are; like the rates, they never leave
// the tab.
export const TOTAL_KEYS = ["aws_total", "runner_nodes"] as const;
export interface PeriodTotals {
  aws_total: number;
  runner_nodes?: number;
}
type PeriodWithTotals = RatePeriod & { totals?: PeriodTotals };
export const MAX_TOTAL = 1e12;

// A periods file holds about 25–30 KB a week; a year of weeks is ~1.6 MB.
export const MAX_PERIOD_RATES_BYTES = 4_000_000;
export const MAX_META_BYTES = 1_000_000;
export const MAX_PERIODS = 800;
// Uncovered slots before the one holding yesterday that also borrow the last
// period. 0 = strict: only the current slot.
export const RATE_GRACE_SLOTS = 0;

const FILES_ERROR =
  "Drop one rates.json and, if you have it, its rates.meta.json.";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// A "YYYY-MM-DD" day on the calendar (as rates.ts reads one), read as UTC.
function isDay(v: unknown): v is Day {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const ms = Date.parse(`${v}T00:00:00Z`);
  return (
    !v.startsWith("0000") &&
    !Number.isNaN(ms) &&
    new Date(ms).toISOString().startsWith(v)
  );
}

// An ISO 8601 day or time: 2026-11-19, 2026-11-19T06:00:00Z, …+01:00.
function isIsoTime(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(
      v
    ) &&
    !Number.isNaN(Date.parse(v))
  );
}

const maxDay = (a: Day, b: Day): Day => (a > b ? a : b);
const minDay = (a: Day, b: Day): Day => (a < b ? a : b);

// ── Words for days ──
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const monthOf = (day: Day) => MONTHS[Number(day.slice(5, 7)) - 1];
const dateOf = (day: Day) => String(Number(day.slice(8, 10)));

// "Nov 9", read as text so no time zone moves it.
export function dayLabel(day: Day): string {
  return `${monthOf(day)} ${dateOf(day)}`;
}

// "Nov 9", "Nov 9–15", "Oct 19 – Nov 15", "Dec 29, 2025 – Jan 4, 2026".
export function daySpanLabel(from: Day, to: Day): string {
  if (from === to) return dayLabel(from);
  if (from.slice(0, 4) !== to.slice(0, 4)) {
    return `${dayLabel(from)}, ${from.slice(0, 4)} – ${dayLabel(
      to
    )}, ${to.slice(0, 4)}`;
  }
  if (from.slice(0, 7) === to.slice(0, 7)) {
    return `${monthOf(from)} ${dateOf(from)}–${dateOf(to)}`;
  }
  return `${dayLabel(from)} – ${dayLabel(to)}`;
}

// "2026-11-02..11-08": a period as a file writes it, for errors.
function spanText(from: Day, to: Day): string {
  return `${from}..${to.slice(0, 4) === from.slice(0, 4) ? to.slice(5) : to}`;
}

function sizeError(file: string, bytes: number, limit: string): string {
  return `${file} is ${Math.round(bytes / 1000).toLocaleString(
    "en-US"
  )} KB; the limit is ${limit}.`;
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

// ── Reading ──
interface RawRates {
  file: string;
  basis: string | null;
  generatedAt: string | null;
  legacy: boolean;
  periods: RatePeriod[];
}
interface RawMetaPeriod {
  validFrom: Day;
  status: "final" | "provisional";
  window: { start: Day; end: Day } | null;
}
interface RawMeta {
  file: string;
  generatedAt: string | null;
  periods: RawMetaPeriod[];
}

// What each loaded set was before a meta joined it, so a later meta replaces
// the first instead of joining on top of it. Keyed by the object handed out.
const RAW = new WeakMap<RatesSet, RawRates>();

function readJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(
      `${file} is not valid JSON (${e instanceof Error ? e.message : e}).`
    );
  }
}

// A file's role, from its content: a meta has no rates anywhere, and either
// a generated_at or periods that each carry a status or lack valid_through.
function isMetaJson(json: unknown): boolean {
  if (!isObject(json) || "rates" in json) return false;
  const periods = json.periods;
  if (Array.isArray(periods)) {
    if (periods.some((p) => isObject(p) && "rates" in p)) return false;
    if (
      periods.length > 0 &&
      periods.every(
        (p) => isObject(p) && ("status" in p || !("valid_through" in p))
      )
    ) {
      return true;
    }
  }
  return "generated_at" in json;
}

function badRates(map: Record<string, unknown>): string | null {
  const bad = Object.entries(map)
    .filter(
      ([, v]) =>
        typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_RATE
    )
    .map(([k, v]) => `${k} is ${JSON.stringify(v)}`);
  if (bad.length === 0) return null;
  return `${bad.slice(0, 3).join("; ")}${
    bad.length > 3 ? `; and ${bad.length - 3} more` : ""
  }`;
}

function parseTotals(v: unknown, where: string): PeriodTotals {
  const shape = `${where}: totals must be {aws_total, runner_nodes?}, $ from 0 to 1e12`;
  if (!isObject(v)) throw new Error(`${shape}.`);
  const unknown = Object.keys(v).filter(
    (k) => !(TOTAL_KEYS as readonly string[]).includes(k)
  );
  if (unknown.length > 0) {
    throw new Error(`${shape}; got ${unknown.slice(0, 3).join(", ")}.`);
  }
  const num = (x: unknown): x is number =>
    typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= MAX_TOTAL;
  if (!num(v.aws_total)) {
    throw new Error(
      `${shape}; aws_total is ${JSON.stringify(v.aws_total ?? null)}.`
    );
  }
  if (v.runner_nodes === undefined) return { aws_total: v.aws_total };
  if (!num(v.runner_nodes)) {
    throw new Error(
      `${shape}; runner_nodes is ${JSON.stringify(v.runner_nodes)}.`
    );
  }
  if (v.runner_nodes > v.aws_total) {
    throw new Error(`${where}: totals.runner_nodes is more than aws_total.`);
  }
  return { aws_total: v.aws_total, runner_nodes: v.runner_nodes };
}

// A period's totals, or null when its file gave none.
export function periodTotals(period: RatePeriod): PeriodTotals | null {
  return (period as PeriodWithTotals).totals ?? null;
}

function parseRatesJson(json: unknown, text: string, file: string): RawRates {
  if (!isObject(json) || !("periods" in json)) {
    // Today's single-set forms, read exactly as rates.ts reads them.
    const legacy = parseRates(text, file);
    return {
      file,
      basis: legacy.basis,
      generatedAt:
        isObject(json) && isObject(json.rates) && isIsoTime(json.generated_at)
          ? json.generated_at
          : null,
      legacy: true,
      periods: [
        {
          validFrom: null,
          validThrough: null,
          rates: legacy.rates,
          status: null,
          window: legacy.window,
        },
      ],
    };
  }
  if ("rates" in json)
    throw new Error("Use either periods or rates, not both.");
  const list = json.periods;
  if (!Array.isArray(list)) {
    throw new Error(
      `${file}: periods must be a list of {valid_from, valid_through, rates}.`
    );
  }
  if (list.length === 0) throw new Error(`${file} has no periods.`);
  if (list.length > MAX_PERIODS) {
    throw new Error(
      `${file} has ${list.length.toLocaleString(
        "en-US"
      )} periods; the limit is ${MAX_PERIODS}.`
    );
  }
  const periods = list.map((p: unknown, i): PeriodWithTotals => {
    const o = isObject(p) ? p : {};
    const where = `Period ${i + 1}${
      isDay(o.valid_from)
        ? ` (${
            isDay(o.valid_through)
              ? spanText(o.valid_from, o.valid_through)
              : o.valid_from
          })`
        : ""
    }`;
    if (!isObject(p)) {
      throw new Error(
        `${where} must be an object with valid_from, valid_through and rates.`
      );
    }
    for (const key of ["valid_from", "valid_through"] as const) {
      if (!isDay(p[key])) {
        throw new Error(
          `${where}: ${key} must be a UTC day like 2026-11-02, got ${JSON.stringify(
            p[key] ?? null
          )}.`
        );
      }
    }
    const from = p.valid_from as Day;
    const through = p.valid_through as Day;
    if (from > through) {
      throw new Error(`${where}: valid_from comes after valid_through.`);
    }
    if (!isObject(p.rates)) {
      throw new Error(
        `${where}: rates must be an object of runner label → $ per runner-hour.`
      );
    }
    const bad = badRates(p.rates);
    if (bad !== null) {
      throw new Error(
        `${where}: rates must be numbers from 0 to 100,000: ${bad}.`
      );
    }
    if (Object.keys(p.rates).length === 0) {
      throw new Error(`${where} has no rates.`);
    }
    const totals = p.totals === undefined ? null : parseTotals(p.totals, where);
    return {
      validFrom: from,
      validThrough: through,
      rates: Object.freeze({ ...(p.rates as Record<string, number>) }),
      status: null,
      window: null,
      ...(totals === null ? {} : { totals: Object.freeze(totals) }),
    };
  });
  periods.sort((a, b) => (a.validFrom! < b.validFrom! ? -1 : 1));
  for (let i = 1; i < periods.length; i++) {
    const [a, b] = [periods[i - 1], periods[i]];
    if (b.validFrom! <= a.validThrough!) {
      throw new Error(
        `Periods ${spanText(a.validFrom!, a.validThrough!)} and ${spanText(
          b.validFrom!,
          b.validThrough!
        )} overlap; each day needs one rate set.`
      );
    }
  }
  return {
    file,
    basis: typeof json.basis === "string" ? json.basis : null,
    generatedAt: isIsoTime(json.generated_at) ? json.generated_at : null,
    legacy: false,
    periods,
  };
}

// A meta is generator output, so anything malformed in it is an error.
function parseMetaJson(json: unknown, file: string): RawMeta {
  if (!isObject(json)) throw new Error(`${file} must be a JSON object.`);
  const at = json.generated_at;
  if (at !== undefined && !isIsoTime(at)) {
    throw new Error(
      `${file}: generated_at must be an ISO 8601 time like 2026-11-19T06:00:00Z.`
    );
  }
  if (!Array.isArray(json.periods)) {
    throw new Error(
      `${file}: periods must be a list of {valid_from, status, window}.`
    );
  }
  const seen = new Set<Day>();
  const periods = json.periods.map((p: unknown, i): RawMetaPeriod => {
    const where = `${file} period ${i + 1}`;
    if (!isObject(p)) throw new Error(`${where} must be an object.`);
    if (!isDay(p.valid_from)) {
      throw new Error(
        `${where}: valid_from must be a UTC day like 2026-11-02.`
      );
    }
    if (p.status !== "final" && p.status !== "provisional") {
      throw new Error(`${where}: status must be final or provisional.`);
    }
    let window: RawMetaPeriod["window"] = null;
    if (p.window !== undefined && p.window !== null) {
      const w = p.window;
      if (!isObject(w) || !isDay(w.start) || !isDay(w.end) || w.start > w.end) {
        throw new Error(
          `${where}: window must be {start, end}, UTC days with start ≤ end.`
        );
      }
      window = { start: w.start, end: w.end };
    }
    if (seen.has(p.valid_from)) {
      throw new Error(`${file} lists period ${p.valid_from} twice.`);
    }
    seen.add(p.valid_from);
    return { validFrom: p.valid_from, status: p.status, window };
  });
  return { file, generatedAt: at ?? null, periods };
}

function join(rates: RawRates, meta: RawMeta | null): RatesSet {
  if (meta !== null && rates.legacy) {
    throw new Error(
      `${meta.file} goes with a rates file of periods; ${rates.file} holds one set for every day.`
    );
  }
  const byStart = new Map(meta?.periods.map((p) => [p.validFrom, p]) ?? []);
  if (meta !== null) {
    const starts = new Set(rates.periods.map((p) => p.validFrom));
    const missing = meta.periods.find((p) => !starts.has(p.validFrom));
    if (missing !== undefined) {
      throw new Error(
        `${meta.file} has period ${missing.validFrom}, which ${rates.file} lacks. Were they generated together?`
      );
    }
    if (
      meta.generatedAt !== null &&
      rates.generatedAt !== null &&
      Date.parse(meta.generatedAt) !== Date.parse(rates.generatedAt)
    ) {
      throw new Error(
        `${rates.file} was generated at ${rates.generatedAt} and ${meta.file} at ${meta.generatedAt}. Were they generated together?`
      );
    }
  }
  const set: RatesSet = {
    file: rates.file,
    metaFile: meta?.file ?? null,
    basis: rates.basis,
    generatedAt: meta?.generatedAt ?? rates.generatedAt,
    legacy: rates.legacy,
    periods: Object.freeze(
      rates.periods.map((p) => {
        const m = p.validFrom === null ? undefined : byStart.get(p.validFrom);
        return Object.freeze(
          m === undefined
            ? p
            : { ...p, status: m.status, window: m.window ?? null }
        );
      })
    ),
  };
  RAW.set(set, rates);
  return set;
}

// A loaded set as its rates.json alone gave it.
function rawOf(set: RatesSet): RawRates {
  return (
    RAW.get(set) ?? {
      file: set.file,
      basis: set.basis,
      generatedAt: set.metaFile === null ? set.generatedAt : null,
      legacy: set.legacy,
      periods: set.periods.map((p) =>
        set.legacy ? p : { ...p, status: null, window: null }
      ),
    }
  );
}

// One rates.json, optionally with its rates.meta.json, in any order; a meta
// alone attaches to (or replaces the meta of) the set already held. Throws a
// one-sentence error and returns nothing partial: the caller keeps what it had.
export function parseRatesFiles(
  files: readonly { name: string; text: string }[],
  held: RatesSet | null = null
): RatesSet {
  if (files.length === 0 || files.length > 2) throw new Error(FILES_ERROR);
  const read = files.map((f) => {
    const bytes = byteLength(f.text);
    if (bytes > MAX_PERIOD_RATES_BYTES) {
      throw new Error(sizeError(f.name, bytes, "4 MB"));
    }
    const json = readJson(f.text, f.name);
    return { ...f, json, bytes, meta: isMetaJson(json) };
  });
  const ratesFiles = read.filter((f) => !f.meta);
  const metaFiles = read.filter((f) => f.meta);
  if (ratesFiles.length > 1 || metaFiles.length > 1) {
    throw new Error(FILES_ERROR);
  }
  const metaFile = metaFiles[0];
  if (metaFile !== undefined && metaFile.bytes > MAX_META_BYTES) {
    throw new Error(sizeError(metaFile.name, metaFile.bytes, "1 MB"));
  }
  const meta =
    metaFile === undefined ? null : parseMetaJson(metaFile.json, metaFile.name);
  const ratesFile = ratesFiles[0];
  if (ratesFile === undefined) {
    if (held === null) {
      throw new Error(
        `${
          metaFile!.name
        } is a rates.meta.json: add its rates.json too (drop both together).`
      );
    }
    return join(rawOf(held), meta);
  }
  return join(
    parseRatesJson(ratesFile.json, ratesFile.text, ratesFile.name),
    meta
  );
}

// A file pricing no runner that ran here is a file of something else (or of
// misspelled labels): it would draw every bar unpriced.
function checkLabels(set: RatesSet, knownLabels: readonly string[]): void {
  const known = knownLabels
    .map(priceKey)
    .filter((k): k is string => k !== null);
  if (known.length === 0) return;
  const keys = new Set(set.periods.flatMap((p) => Object.keys(p.rates)));
  if (!known.some((k) => keys.has(k))) {
    throw new Error(
      `None of ${set.file}'s labels ran here; keys are runner labels like ${known[0]}.`
    );
  }
}

// Files a reader dropped or chose: size-checked before they are read, then
// parsed and checked against the runner labels the trend answer holds.
// Rejects with one sentence; the caller keeps the rates it had.
export async function readRatesFiles(
  files: readonly File[],
  knownLabels: readonly string[],
  held: RatesSet | null = null
): Promise<RatesSet> {
  if (files.length === 0 || files.length > 2) throw new Error(FILES_ERROR);
  const big = files.find((f) => f.size > MAX_PERIOD_RATES_BYTES);
  if (big !== undefined) throw new Error(sizeError(big.name, big.size, "4 MB"));
  const texts = await Promise.all(
    files.map(async (f) => ({ name: f.name, text: await f.text() }))
  );
  const set = parseRatesFiles(texts, held);
  checkLabels(set, knownLabels);
  return set;
}

// ── Describing a set ──
// "weekly" when every period is 7 days, "monthly" when every one is a
// calendar month, "daily" for single days; null for a mix.
export function cadenceOf(
  set: RatesSet
): "daily" | "weekly" | "monthly" | null {
  if (set.legacy || set.periods.length === 0) return null;
  const lengths = set.periods.map((p) =>
    daysIn({ from: p.validFrom!, to: p.validThrough! })
  );
  if (lengths.every((n) => n === 7)) return "weekly";
  if (lengths.every((n) => n === 1)) return "daily";
  const month = (p: RatePeriod) =>
    p.validFrom!.endsWith("-01") &&
    p.validFrom!.slice(0, 7) === p.validThrough!.slice(0, 7) &&
    addDays(p.validThrough!, 1).endsWith("-01");
  return set.periods.every(month) ? "monthly" : null;
}

// The control's chip: "rates.json · 4 weekly periods · Oct 19 – Nov 15 ·
// generated Nov 19"; "rates.json · one set for every day". short keeps the
// file and its periods, for the title row (the rest goes in its tooltip).
export function ratesChip(set: RatesSet, short = false): string {
  if (set.legacy) return `${set.file} · one set for every day`;
  const n = set.periods.length;
  const cadence = cadenceOf(set);
  const first = set.periods[0];
  const last = set.periods[n - 1];
  const parts = [
    set.file,
    `${n} ${cadence === null ? "" : `${cadence} `}period${n === 1 ? "" : "s"}`,
  ];
  if (short) return parts.join(" · ");
  parts.push(daySpanLabel(first.validFrom!, last.validThrough!));
  if (set.generatedAt !== null) {
    parts.push(`generated ${dayLabel(set.generatedAt.slice(0, 10))}`);
  }
  return parts.join(" · ");
}

// A period's days in words: "Nov 9–15"; a legacy set's "every day".
export function periodLabel(set: RatesSet, period: number): string {
  const p = set.periods[period];
  return p.validFrom === null || p.validThrough === null
    ? "every day"
    : daySpanLabel(p.validFrom, p.validThrough);
}

// ── Pricing ──
// The current slot: with today = the answer's end and
// y = today − 1, the slot of the file's own grid holding y, after the file's
// last period, borrows that period. null when the file reaches y, or for a
// legacy set (it covers every day).
export function currentPeriod(
  set: RatesSet,
  today: Day
): { from: Day; to: Day; period: number } | null {
  if (set.legacy || set.periods.length === 0) return null;
  const y = addDays(today, -1);
  const period = set.periods.length - 1;
  const last = set.periods[period];
  if (last.validThrough! >= y) return null;
  const length = daysIn({ from: last.validFrom!, to: last.validThrough! });
  const gapStart = addDays(last.validThrough!, 1);
  const slot = Math.floor((daysIn({ from: gapStart, to: y }) - 1) / length);
  const slotStart = addDays(gapStart, slot * length);
  return {
    from: maxDay(gapStart, addDays(slotStart, -RATE_GRACE_SLOTS * length)),
    to: y,
    period,
  };
}

interface DayPricing {
  kind: RateDayKind;
  period: number | null;
}
const GAP: DayPricing = { kind: "gap", period: null };

export function makePricer(set: RatesSet, today: Day): Pricer {
  const periods = set.periods;
  const current = currentPeriod(set, today);
  const pricings = new Map<Day, DayPricing>();
  const keys = new Map<string, string | null>();

  function find(day: Day): DayPricing {
    if (set.legacy) return { kind: "legacy", period: 0 };
    if (current !== null && day >= current.from && day <= current.to) {
      return { kind: "borrowed", period: current.period };
    }
    // The last period starting on or before the day.
    let lo = 0;
    let hi = periods.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (periods[mid].validFrom! <= day) {
        at = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (at < 0 || day > periods[at].validThrough!) return GAP;
    return {
      kind: periods[at].status === "provisional" ? "provisional" : "final",
      period: at,
    };
  }
  function pricing(day: Day): DayPricing {
    let p = pricings.get(day);
    if (p === undefined) {
      p = find(day);
      pricings.set(day, p);
    }
    return p;
  }
  function keyOf(label: string): string | null {
    let k = keys.get(label);
    if (k === undefined) {
      k = priceKey(label);
      keys.set(label, k);
    }
    return k;
  }
  function rate(label: string, day: Day): number | null {
    const key = keyOf(label);
    const { period } = pricing(day);
    if (key === null || period === null) return null;
    const rates = periods[period].rates;
    return Object.hasOwn(rates, key) ? rates[key] : null;
  }
  function piece(label: string, days: readonly Day[]): PieceRate {
    let priced = 0;
    let sum = 0;
    let first: number | null = null;
    let same = true;
    let borrowed = false;
    for (const day of days) {
      const r = rate(label, day);
      if (r === null) continue;
      priced += 1;
      sum += r;
      if (first === null) first = r;
      else if (r !== first) same = false;
      if (pricing(day).kind === "borrowed") borrowed = true;
    }
    return {
      // One rate as given, so an exact piece adds no float error.
      rate: priced === 0 ? null : same ? first : sum / priced,
      priced: days.length > 0 ? priced / days.length : 0,
      // h·priced·rate is exact whatever the hours' spread over the days when
      // every day has the one rate, or none has any.
      exact: priced === 0 || (same && priced === days.length),
      borrowed,
    };
  }
  function segments(range: DayRange): RateSegment[] {
    const out: RateSegment[] = [];
    if (range.from > range.to) return out;
    for (let day = range.from; day <= range.to; day = addDays(day, 1)) {
      const p = pricing(day);
      const prev = out[out.length - 1];
      if (
        prev !== undefined &&
        prev.kind === p.kind &&
        prev.period === p.period
      ) {
        prev.to = day;
      } else {
        out.push({ from: day, to: day, kind: p.kind, period: p.period });
      }
    }
    return out;
  }
  // One quiet line, only when something is notable. range = the
  // shown days with data (days before the data or after y would read as gaps).
  function coverageLine(range: DayRange, unpricedHours: number): string | null {
    const unpriced =
      unpricedHours >= 0.5 ? `${hoursLabel(unpricedHours)} h unpriced` : null;
    if (set.legacy) {
      return unpricedHours >= 0.5
        ? `${hoursLabel(unpricedHours)} h on labels without a rate`
        : null;
    }
    const y = addDays(today, -1);
    const segs = segments({ from: range.from, to: minDay(range.to, y) });
    const provisional = Array.from(
      new Set(
        segs.filter((s) => s.kind === "provisional").map((s) => s.period!)
      )
    );
    const borrowed = segs.filter((s) => s.kind === "borrowed");
    const gaps = segs.filter((s) => s.kind === "gap");
    if (
      provisional.length === 0 &&
      borrowed.length === 0 &&
      gaps.length === 0 &&
      unpriced === null
    ) {
      return null;
    }
    const last = periods[periods.length - 1];
    const parts = [
      `Rates ${daySpanLabel(periods[0].validFrom!, last.validThrough!)}${
        provisional.length > 0
          ? ` (${provisional
              .map((p) => periodLabel(set, p))
              .join(", ")} provisional)`
          : ""
      }`,
      ...borrowed.map(
        (s) =>
          `≈ ${daySpanLabel(s.from, s.to)} priced with ${periodLabel(
            set,
            s.period!
          )} rates`
      ),
      ...(gaps.length > 0
        ? [`${gaps.map((s) => daySpanLabel(s.from, s.to)).join(", ")} no rates`]
        : []),
      ...(unpriced === null ? [] : [unpriced]),
    ];
    return parts.join(" · ");
  }
  return {
    set,
    today,
    rate,
    piece,
    dayKind: (day) => pricing(day).kind,
    segments,
    coverageLine,
  };
}

// A day's share of its period's totals (each total ÷ the period's days), by
// the period pricing it: a borrowed day takes the last period's, as for its
// rates; a gap day, a legacy set or a period without totals has none.
export function dayTotals(
  pricer: Pricer,
  day: Day
): { aws_total: number; runner_nodes: number | null } | null {
  // A pricer without a set (a test double) has no totals either.
  const periods = pricer.set?.periods;
  if (periods === undefined || pricer.set.legacy) return null;
  const at = pricer.segments({ from: day, to: day })[0]?.period ?? null;
  const p = at === null ? undefined : periods[at];
  const totals = p === undefined ? null : periodTotals(p);
  if (p === undefined || totals === null) return null;
  const n = daysIn({ from: p.validFrom!, to: p.validThrough! });
  return {
    aws_total: totals.aws_total / n,
    runner_nodes:
      totals.runner_nodes === undefined ? null : totals.runner_nodes / n,
  };
}

// What $ per day and $ per commit divide by. Priced days are
// days with data whose pricing is not a gap; per commit in $ divides the $ of
// push:main hours on those days by their pushes. note = "5 of 7 days priced"
// when some aren't.
export function pricedDays(
  pricer: Pricer,
  side: { days: readonly Day[]; pushes?: readonly number[] }
): { days: number; of: number; pushes: number; note: string | null } {
  let days = 0;
  let pushes = 0;
  side.days.forEach((day, i) => {
    if (pricer.dayKind(day) === "gap") return;
    days += 1;
    pushes += side.pushes?.[i] ?? 0;
  });
  const of = side.days.length;
  return {
    days,
    of,
    pushes,
    note: days < of ? `${days} of ${of} days priced` : null,
  };
}

// How some days with data were priced, for a tooltip or a card.
// approx: a day borrowed the file's last period (≈). lines: "≈ priced with
// Nov 9–15 rates (no rates for these days yet)", "Provisional: rates from
// Nov 9–13".
export function pricingNotes(
  pricer: Pricer,
  days: readonly Day[]
): { approx: boolean; lines: string[] } {
  const set = pricer.set;
  let borrowed: number | null = null;
  const provisional = new Set<number>();
  for (const day of days) {
    const kind = pricer.dayKind(day);
    if (kind !== "borrowed" && kind !== "provisional") continue;
    const period = pricer.segments({ from: day, to: day })[0]?.period ?? null;
    if (period === null) continue;
    if (kind === "borrowed") borrowed = period;
    else provisional.add(period);
  }
  const lines: string[] = [];
  if (borrowed !== null) {
    const last = set.periods[borrowed];
    lines.push(
      `≈ priced with ${periodLabel(set, borrowed)} rates (${
        last?.status === "provisional" ? "provisional; " : ""
      }no rates for these days yet)`
    );
  }
  for (const period of Array.from(provisional).sort((x, y) => x - y)) {
    const w = set.periods[period].window;
    lines.push(
      `Provisional: rates from ${
        w === null ? periodLabel(set, period) : daySpanLabel(w.start, w.end)
      }`
    );
  }
  return { approx: borrowed !== null, lines };
}
