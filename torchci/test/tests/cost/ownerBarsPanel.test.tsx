// The owner bars panel (components/tests/cost/owners) from owners_b.json, B
// = Nov 11–17 (7v7 with L = Nov 17): the band (title, B, the keys), the bars,
// always split by machine, and the machine key, the footnote; a key, an
// owner and a machine as the page's writes; a machine's runners and a row's
// runners drawer, adding up; the fold kept in the browser and asking for
// nothing; $ with FAKE rates; every empty state; and dark mode.

import { createTheme, ThemeProvider } from "@mui/material/styles";
import OwnerBars from "components/tests/cost/owners/OwnerBars";
import OwnerBarsPanel, {
  OWNER_BARS_OPEN,
} from "components/tests/cost/owners/OwnerBarsPanel";
import RunnersDrawer from "components/tests/cost/owners/RunnersDrawer";
import {
  addDays,
  type CostOwners,
  type Day,
  type OwnerBarsPanelProps,
  type Pill,
  type TrendContext,
  type TrendsQuery,
} from "lib/api/tests/cost/contracts";
import { machineHue } from "lib/tests/cost/colors";
import { ownerBarsModel } from "lib/tests/cost/ownerBars";
import { makePricer, parseRatesFiles } from "lib/tests/cost/ratePeriods";
import { prepareRunnerHours } from "lib/tests/cost/runnerHours";
import { presetPatch, resolveCompare } from "lib/tests/cost/select";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from "react-test-renderer";
import OWNERS_JSON from "./owners_b.json";

jest.mock("components/tests/cost/trends/TrendTooltip", () => ({
  __esModule: true,
  ...jest.requireActual("components/tests/cost/trends/TrendTooltip"),
  default: () => null,
}));

const OWNERS = OWNERS_JSON as unknown as CostOwners;

// /owners answers from mockAnswer, echoing the URL asked (scope, range and
// piece), every URL asked recorded; mockState says what else to answer.
const mockAsked: (string | null)[] = [];
let mockState: "ok" | "loading" | "error" = "ok";
let mockRows: ((_a: CostOwners) => CostOwners) | null = null;
function mockAnswer(url: string): CostOwners {
  const params = new URL(url, "http://hud").searchParams;
  const from = params.get("from") as Day;
  const to = params.get("to") as Day;
  const day = params.get("piece") === "day";
  const base: CostOwners = {
    ...OWNERS,
    workflows: params.getAll("workflow"),
    from,
    to,
    days: OWNERS.days.map((_, i) => addDays(from, i)),
    piece: day ? "day" : null,
    cells: day ? OWNERS.cells : [],
  };
  return mockRows === null ? base : mockRows(base);
}
jest.mock("lib/tests/useApiResource", () => ({
  useApiResource: (url: string | null) => {
    mockAsked.push(url);
    const owners = url !== null && url.startsWith("/api/tests/cost/owners");
    return {
      data: owners && mockState === "ok" ? mockAnswer(url) : undefined,
      error:
        owners && mockState === "error"
          ? new Error("database unavailable")
          : undefined,
      isLoading: owners && mockState === "loading",
      retrying: false,
      retry: () => Promise.resolve(),
    };
  },
}));

const pricerOf = (...names: string[]) =>
  makePricer(
    parseRatesFiles(
      names.map((name) => ({
        name,
        text: readFileSync(join(__dirname, name), "utf8"),
      }))
    )
  );
const WEEKLY = pricerOf(
  "rates_FAKE_weekly.json",
  "rates_FAKE_weekly.meta.json"
);
const GAP = pricerOf("rates_FAKE_weekly_gap.json");

function ctxOf(from: Day, to: Day, end: Day): TrendContext {
  const days: Day[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return {
    end,
    firstDay: days[0],
    lastFull: to,
    days: new Set(days),
    filling: new Set(),
  };
}
// Data Oct 15 – Nov 17, today Nov 18: L = Nov 17, so 7v7's B is the
// fixture's.
const CTX = ctxOf("2026-10-15", "2026-11-17", "2026-11-18");
const query = (patch: Partial<TrendsQuery> = {}): TrendsQuery => ({
  rollup: "day",
  show: null,
  cmp: "7v7",
  a: null,
  b: null,
  per: "day",
  unit: "hours",
  ...patch,
});

function props(patch: Partial<OwnerBarsPanelProps> = {}): OwnerBarsPanelProps {
  const ctx = patch.context === undefined ? CTX : patch.context;
  const q = patch.query ?? query();
  const compare = ctx === null ? null : resolveCompare(q, ctx);
  return {
    repo: "pytorch/pytorch",
    workflows: [],
    scopeLabel: "all workflows",
    context: ctx,
    query: q,
    compare,
    settled: compare,
    onTrendsChange: jest.fn(),
    unit: "hours",
    pricer: null,
    runnerHours: undefined,
    trail: [],
    onTrailChange: jest.fn(),
    ...patch,
  };
}

// MUI's Tooltip reads back the attribute it put on its child.
const nodeMock = (element: { props: Record<string, unknown> }) => ({
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 300 }),
  focus: () => {},
  getAttribute: (name: string) => element.props[name] ?? null,
  setAttribute: () => {},
  removeAttribute: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  style: {},
});

function render(p: OwnerBarsPanelProps): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => {
    r = create(<OwnerBarsPanel {...p} />, { createNodeMock: nodeMock });
  });
  return r;
}

// An instance's words: its strings in order, spaces collapsed.
function textOf(node: ReactTestInstance | string): string {
  if (typeof node === "string") return node;
  return node.children.map(textOf).join(" ");
}
const words = (r: ReactTestRenderer) =>
  textOf(r.root).replace(/\s+/g, " ").trim();
// The words as read: no space before punctuation or after "(".
const prose = (r: ReactTestRenderer) =>
  words(r)
    .replace(/ ([.,:;)']|&apos;)/g, "$1")
    .replace(/\( /g, "(");
const host = (r: ReactTestRenderer, pick: (_n: ReactTestInstance) => boolean) =>
  r.root.findAll((n) => typeof n.type === "string" && pick(n));
const click = (n: ReactTestInstance) =>
  act(() =>
    n.props.onClick({ stopPropagation() {}, preventDefault() {}, detail: 1 })
  );
const key = (label: string) =>
  host(
    r0(),
    (n) => n.props["aria-pressed"] !== undefined && textOf(n).trim() === label
  )[0];
let current: ReactTestRenderer | null = null;
const r0 = () => current as ReactTestRenderer;

// A second renderer beside the SSR ones, and emotion with no document to
// hand a ref to: React's two dev warnings about that, nothing else.
const error = console.error;
beforeAll(() => {
  jest.spyOn(console, "error").mockImplementation((...a) => {
    if (/multiple renderers|cannot be given refs/.test(String(a[0]))) return;
    error(...a);
  });
});
afterAll(() => jest.restoreAllMocks());

beforeEach(() => {
  mockAsked.length = 0;
  mockState = "ok";
  mockRows = null;
});
afterEach(() => {
  if (current !== null) act(() => current!.unmount());
  current = null;
});

describe("the panel, open", () => {
  test("the band, B, the keys, the header line, the axis, the rows, the key and the footnote", () => {
    current = render(props());
    const w = words(current);
    expect(w).toContain("Usage by owner");
    expect(w).toContain("· B Nov 11 – Nov 17 · 7 days");
    expect(w).toContain("Last day Last 3 days Last 7 days Hours $");
    expect(w).not.toContain("Split by machine");
    expect(w).toContain("578 runner-hours in all workflows");
    expect(w).toContain("runner-hours share of 578");
    expect(w).toMatch(/inductor .*260 h 45%/);
    expect(w).toMatch(/Unattributed ▸ .*91 h 16%/);
    expect(w).toContain("Machines · share of 578 h");
    expect(w).toMatch(/Bar colors\. Click to drill in; ▸ lists runners ?\./);
    expect(w).toMatch(/Linux x86_64 avx512 38% 220 h/);
    expect(w).toContain(
      "Machines from test reports; striped: estimated from runner labels; grey stripes: unknown. › lists a row's runners."
    );
    // One request: B, every workflow, no day cells in hours.
    expect(mockAsked.filter((u) => u !== null)).toContain(
      "/api/tests/cost/owners?repo=pytorch%2Fpytorch&from=2026-11-11&to=2026-11-17"
    );
    // 7v7 is in force; the others are not.
    expect(key("Last 7 days").props["aria-pressed"]).toBe(true);
    expect(key("Last day").props["aria-pressed"]).toBe(false);
    expect(key("Last 3 days").props["aria-pressed"]).toBe(false);
  });

  test("past the top owners: N more owners, listed on a click; Unattributed lists its buckets", () => {
    mockRows = (a) => ({
      ...a,
      rows: [
        ...a.rows,
        ...Array.from({ length: 14 }, (_, i) => ({
          ...a.rows[0],
          owner: `owner_${String(i).padStart(2, "0")}`,
          runner_hours: 1,
        })),
      ],
    });
    current = render(props());
    expect(words(current)).toContain("2 more owners ▸");
    const more = host(
      current,
      (n) => n.props.role === "button" && textOf(n).includes("2 more owners")
    )[0];
    click(more);
    expect(words(current)).toContain("Show fewer ▴");
    const bucket = host(
      current,
      (n) =>
        n.props.role === "button" &&
        String(n.props["aria-label"]).startsWith("List the unattributed")
    )[0];
    act(() => bucket.props.onKeyDown({ key: "Enter", preventDefault() {} }));
    expect(words(current)).toMatch(
      /Unattributed ▾ .*No owner .*No test reports/
    );
  });

  test("Last day and Last 7 days write Trends' presets for the whole page", () => {
    const p = props({ query: query({ cmp: "dod" }) });
    current = render(p);
    expect(key("Last day").props["aria-pressed"]).toBe(true);
    click(key("Last 7 days"));
    expect(p.onTrendsChange).toHaveBeenLastCalledWith(
      presetPatch("7v7", p.query, CTX)
    );
    expect(p.onTrendsChange).toHaveBeenLastCalledWith({
      rollup: "day",
      show: null,
      cmp: "7v7",
      a: null,
      b: null,
    });
    click(key("Last day"));
    expect(p.onTrendsChange).toHaveBeenLastCalledWith(
      presetPatch("dod", p.query, CTX)
    );
  });

  test("Last 3 days writes A and B as a custom pick does, and is lit while they are those days", () => {
    const p = props({ query: query({ rollup: "week", cmp: null, show: 26 }) });
    current = render(p);
    click(key("Last 3 days"));
    const patch: Partial<TrendsQuery> = {
      rollup: "day",
      show: null,
      cmp: null,
      a: { from: "2026-11-12", to: "2026-11-14" },
      b: { from: "2026-11-15", to: "2026-11-17" },
    };
    expect(p.onTrendsChange).toHaveBeenLastCalledWith(patch);
    act(() => current!.unmount());
    // Written, the page's A and B are those days: lit, the presets not.
    const after: TrendsQuery = { ...p.query, ...patch };
    expect(resolveCompare(after, CTX)).toMatchObject({
      a: patch.a,
      b: patch.b,
      preset: null,
    });
    current = render(props({ query: after }));
    expect(key("Last 3 days").props["aria-pressed"]).toBe(true);
    expect(key("Last 7 days").props["aria-pressed"]).toBe(false);
    expect(mockAsked).toContain(
      "/api/tests/cost/owners?repo=pytorch%2Fpytorch&from=2026-11-15&to=2026-11-17"
    );
  });

  test("Hours and $ write the page's unit, as Trends' keys do; $ waits for a rates file", () => {
    const p = props();
    current = render(p);
    expect(key("Hours").props["aria-pressed"]).toBe(true);
    expect(key("$").props["aria-disabled"]).toBe(true);
    click(key("Hours"));
    expect(p.onTrendsChange).toHaveBeenCalledWith({ unit: "hours" });
    act(() => current!.unmount());

    const q = props({ pricer: WEEKLY });
    current = render(q);
    expect(key("$").props["aria-disabled"]).toBeFalsy();
    click(key("$"));
    expect(q.onTrendsChange).toHaveBeenCalledWith({ unit: "usd" });
    act(() => current!.unmount());

    current = render(props({ unit: "usd", pricer: WEEKLY }));
    expect(key("$").props["aria-pressed"]).toBe(true);
    expect(key("Hours").props["aria-pressed"]).toBe(false);
  });

  test("an owner is the drill's owner pill, off on a second click; a machine its machine pill", () => {
    const p = props();
    current = render(p);
    const bar = (label: string) =>
      host(
        current!,
        (n) =>
          n.props.role === "button" &&
          String(n.props["aria-label"]).startsWith(`Drill into ${label}:`)
      )[0];
    act(() =>
      bar("inductor").props.onKeyDown({ key: "Enter", preventDefault() {} })
    );
    expect(p.onTrailChange).toHaveBeenLastCalledWith([
      { dim: "o", value: "inductor" },
    ]);
    // The row's click does the same.
    const rows = host(
      current,
      (n) =>
        n.props.onClick !== undefined &&
        n.findAll((c) => c.props.title === "inductor").length > 0
    );
    click(rows[rows.length - 1]);
    expect(p.onTrailChange).toHaveBeenCalledTimes(2);
    expect(p.onTrailChange).toHaveBeenLastCalledWith([
      { dim: "o", value: "inductor" },
    ]);
    const machine = host(
      current,
      (n) =>
        typeof n.props.title === "string" &&
        n.props.title.startsWith("NVIDIA L4:") &&
        n.props.onClick !== undefined
    )[0];
    click(machine);
    expect(p.onTrailChange).toHaveBeenLastCalledWith([
      { dim: "m", value: "NVIDIA L4" },
    ]);
    act(() => current!.unmount());
    const pinned: Pill[] = [{ dim: "o", value: "inductor" }];
    const q = props({ trail: pinned });
    current = render(q);
    const w = words(current);
    expect(w).toContain("✓ inductor");
    expect(w).toMatch(/· inductor ?: 260 h \( ?45% ?\) Clear/);
    // The key's shares are inductor's, as the drill's machines of inductor.
    expect(w).toContain("Machines · share of inductor's 260 h");
    act(() =>
      host(
        current!,
        (n) =>
          n.props.role === "button" &&
          String(n.props["aria-label"]).startsWith("Drill into inductor:")
      )[0].props.onKeyDown({ key: " ", preventDefault() {} })
    );
    expect(q.onTrailChange).toHaveBeenLastCalledWith([]);
  });

  test("no split toggle: every bar is its machines' pieces", () => {
    current = render(props());
    expect(
      host(current, (n) => n.type === "input" && n.props.type === "checkbox")
    ).toHaveLength(0);
    // inductor's bar: its machines' pieces in the machines' fixed order, as
    // its tooltip lists them.
    const tip = current.root.find(
      (n) =>
        typeof n.props.title === "string" &&
        n.props.title.startsWith("inductor: 260 h")
    );
    expect(tip.props.title.split("\n")).toEqual([
      "inductor: 260 h · 45% of all workflows",
      "Linux x86_64 avx512: 60 h (23%)",
      "NVIDIA L4: 120 h (46%)",
      "NVIDIA A10G: 80 h (31%)",
      "Click to drill in",
    ]);
  });
});

// The table rows drawn: each row's cells' words.
const tableRows = (r: ReactTestRenderer) =>
  host(r, (n) => n.type === "tr").map((tr) =>
    host(r, (n) => (n.type === "td" || n.type === "th") && isIn(n, tr)).map(
      (c) => textOf(c).replace(/\s+/g, " ").trim()
    )
  );
function isIn(n: ReactTestInstance, of: ReactTestInstance): boolean {
  for (let p: ReactTestInstance | null = n.parent; p !== null; p = p.parent) {
    if (p === of) return true;
  }
  return false;
}
const button = (r: ReactTestRenderer, label: string) =>
  host(r, (n) => n.props["aria-label"] === label)[0];

describe("runners", () => {
  test("a machine's ▸ lists its runners, the most runner-hours first; they add up to it", () => {
    current = render(props());
    expect(words(current)).not.toContain("mt-l-x86iavx512-16-128");
    click(button(current, "List Linux x86_64 avx512's runners"));
    // 180 h + 40 h of the machine's 220 h; 31% + 7% of its 38%.
    expect(words(current)).toMatch(
      /Linux x86_64 avx512 38% 220 h mt-l-x86iavx512-16-128 31% 180 h lf-l-x86iavx512-16-128 7% 40 h/
    );
    expect(
      button(current, "Fold Linux x86_64 avx512's runners").props[
        "aria-expanded"
      ]
    ).toBe(true);
    // Unknown machine lists its runner labels too.
    click(button(current, "List Unknown machine's runners"));
    expect(words(current)).toMatch(
      /Unknown machine 4% 26 h linux\.idc\.xpu 4% 26 h/
    );
  });

  test("a row's › opens its machines and runners at the page's edge; they add up to the row; Esc closes it", () => {
    current = render(props());
    click(button(current, "Machines and runners of inductor"));
    const w = words(current);
    expect(w).toContain(
      "Owner inductor 260 h · 45% of 578 h · in all workflows"
    );
    expect(tableRows(current)).toEqual([
      ["Machine · runner", "Runner-hours", "Share"],
      ["NVIDIA L4", "120 h", "46%"],
      ["mt-l-x86aavx2-11-41-l4", "120 h", "100%"],
      ["NVIDIA A10G", "80 h", "31%"],
      ["mt-l-x86aavx2-11-41-a10g", "80 h", "100%"],
      ["Linux x86_64 avx512", "60 h", "23%"],
      ["mt-l-x86iavx512-16-128", "60 h", "100%"],
    ]);
    // A second ›: Unattributed, its buckets together, estimated machines
    // named, Unknown machine last.
    click(button(current, "Machines and runners of Unattributed"));
    expect(words(current)).toContain(
      "Unattributed Unattributed 91 h · 16% of 578 h"
    );
    expect(tableRows(current)).toEqual([
      ["Machine · runner", "Runner-hours", "Share"],
      ["AMD Instinct MI355X · 100% est.", "40 h", "44%"],
      ["amd-dpx-linux.rocm.gpu.gfx950.1", "40 h", "100%"],
      ["Linux x86_64 avx512", "20 h", "22%"],
      ["mt-l-x86iavx512-16-128", "20 h", "100%"],
      ["NVIDIA L4 · 100% est.", "5 h", "6%"],
      ["mt-l-x86aavx2-11-41-l4", "5 h", "100%"],
      ["Unknown machine", "26 h", "28%"],
      ["linux.idc.xpu", "26 h", "100%"],
    ]);
    const drawer = host(current, (n) => n.props.role === "complementary")[0];
    expect(drawer.props["aria-label"]).toBe(
      "Machines and runners of Unattributed"
    );
    act(() =>
      drawer.props.onKeyDown({
        key: "Escape",
        preventDefault() {},
        stopPropagation() {},
      })
    );
    expect(host(current, (n) => n.props.role === "complementary")).toEqual([]);
    expect(tableRows(current)).toEqual([]);
  });

  test("N more owners has its ›; × closes the drawer", () => {
    mockRows = (a) => ({
      ...a,
      rows: [
        ...a.rows,
        ...Array.from({ length: 14 }, (_, i) => ({
          ...a.rows[0],
          owner: `owner_${String(i).padStart(2, "0")}`,
          runner_hours: 1,
        })),
      ],
    });
    current = render(props());
    click(button(current, "Machines and runners of 2 more owners"));
    expect(words(current)).toContain(
      "Owners outside the top 2 more owners 2 h"
    );
    expect(tableRows(current).slice(1)).toEqual([
      ["NVIDIA L4", "2 h", "100%"],
      ["mt-l-x86aavx2-11-41-l4", "2 h", "100%"],
    ]);
    click(button(current, "Close (Esc)"));
    expect(tableRows(current)).toEqual([]);
  });
});

describe("the fold", () => {
  const store = { getItem: jest.fn(() => null), setItem: jest.fn() };
  beforeAll(() => {
    (globalThis as { localStorage?: unknown }).localStorage = store;
  });
  afterAll(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  test("the title folds it, kept in the browser; folded, the band stays and nothing is asked", () => {
    current = render(props());
    const title = host(
      current,
      (n) => n.props["aria-expanded"] === true && n.type === "button"
    )[0];
    mockAsked.length = 0;
    click(title);
    expect(store.setItem).toHaveBeenCalledWith(OWNER_BARS_OPEN, "false");
    const w = words(current);
    expect(w).toContain("Usage by owner");
    expect(w).toContain("Last 7 days");
    expect(w).not.toContain("Machines");
    expect(mockAsked.length).toBeGreaterThan(0);
    expect(mockAsked.every((u) => u === null)).toBe(true);
  });
});

describe("$ with FAKE rates", () => {
  test("Usage by owner in $: day cells asked, the priced days and the unpriced hours named", () => {
    current = render(props({ unit: "usd", pricer: WEEKLY }));
    const w = words(current);
    expect(w).toContain("Usage by owner");
    expect(w).not.toContain("Cost by owner");
    expect(w).toMatch(
      /≈ \$134 in all workflows · 5 of 7 days priced · 192 h unpriced/
    );
    expect(mockAsked).toContain(
      "/api/tests/cost/owners?repo=pytorch%2Fpytorch&from=2026-11-11&to=2026-11-17&piece=day"
    );
    // Nothing of the rates file in any request.
    for (const url of mockAsked) expect(String(url)).not.toMatch(/rate|0\.55/);
  });

  test("the key in $: each machine's and runner's $/h, no rate with its hours, and the runners without a rate", () => {
    current = render(props({ unit: "usd", pricer: WEEKLY }));
    click(button(current, "List NVIDIA L4's runners"));
    click(button(current, "List AMD Instinct MI355X's runners"));
    const w = prose(current);
    expect(w).toContain("Bar colors. Click to drill in; ▸ lists runners.");
    // Nov 11–15 priced at FAKE $0.55/h: 0.8 of 125 h and of 50 h.
    expect(w).toMatch(
      /NVIDIA L4 ~\$0\.55\/h 58% \$77 mt-l-x86aavx2-11-41-l4 \$0\.55\/h 41% \$55 lf-l-x86aavx2-11-41-l4 \$0\.55\/h 16% \$22/
    );
    expect(w).toMatch(
      /AMD Instinct MI355X no rate 40 h amd-dpx-linux\.rocm\.gpu\.gfx950\.1 no rate 40 h/
    );
    // On priced days only: 0.8 of 40, 30 and 25.6 h, of 0.8 × 578 h.
    expect(w).toContain(
      "No rate: 76 h (17% of runner-hours on priced days) on 3 runners, largest amd-dpx-linux.rocm.gpu.gfx950.1 (32 h), windows.4xlarge.nonephemeral (24 h)."
    );
    // A runner's tooltip counts its unpriced hours (Nov 16–17).
    expect(
      current.root.find(
        (n) =>
          typeof n.props.title === "string" &&
          n.props.title.startsWith("mt-l-x86aavx2-11-41-l4:")
      ).props.title
    ).toBe(
      "mt-l-x86aavx2-11-41-l4: 125 h, 25 h unpriced · $0.55/h · $55 · 71% of NVIDIA L4's"
    );
  });

  test("Other machines in $: its bar, share and $, with a rate where any of its machines has one", () => {
    // The page hues two of B's six machines: the other four are a group.
    const page = prepareRunnerHours(OWNERS);
    const runnerHours = {
      ...page,
      colored: ["Linux x86_64 avx512", "NVIDIA L4"].map((name) =>
        page.machines.indexOf(name)
      ),
    };
    current = render(props({ unit: "usd", pricer: WEEKLY, runnerHours }));
    // A10G's 64 priced h at FAKE $0.55/h and M1's 5.9 at $0.33/h; MI355X
    // and Windows have no rate: $37 over 70 priced h of 157.
    expect(prose(current)).toContain(
      "▸ NVIDIA L4 ~$0.55/h 58% $77 ▸ Other machines (4) 28% $37 ▸ Unknown machine no rate 26 h"
    );
    expect(
      current.root.find(
        (n) =>
          typeof n.props.title === "string" &&
          n.props.title.startsWith("Other machines (4):")
      ).props.title
    ).toBe("Other machines (4): 157 h, 87 h unpriced · ~$0.531/h · $37");
    // Listed, each member keeps its own figures.
    click(button(current, "List the other machines"));
    expect(prose(current)).toMatch(/Windows x86_64 avx512 no rate 30 h/);
  });

  test("the drawer in $: $/h, $, the unpriced hours, no rate, and a note naming the runners without one", () => {
    current = render(props({ unit: "usd", pricer: WEEKLY }));
    click(button(current, "Machines and runners of dynamo"));
    // 0.2 of its 137.4 h past the file, and Windows' 0.8 × 30 h no rate.
    expect(prose(current)).toContain(
      "Owner dynamo $11 · 8% of $134 · 137 runner-hours, 51 h unpriced · in all workflows"
    );
    expect(tableRows(current)).toEqual([
      ["Machine · runner", "Runner-hours", "Unpriced", "$/h", "$", "Share"],
      ["Linux x86_64 avx512", "100 h", "20 h", "~$0.11/h", "$9", "82%"],
      ["mt-l-x86iavx512-16-128", "100 h", "20 h", "$0.11/h", "$9", "100%"],
      ["Apple M1", "7 h", "1 h", "~$0.33/h", "$2", "18%"],
      ["macos-m1-stable", "7 h", "1 h", "$0.33/h", "$2", "100%"],
      ["Windows x86_64 avx512", "30 h", "", "no rate", "—", "—"],
      ["windows.4xlarge.nonephemeral", "30 h", "", "no rate", "—", "—"],
    ]);
    expect(prose(current)).toContain(
      "No rate: 1 runner, 24 h (22% of dynamo's runner-hours on priced days): windows.4xlarge.nonephemeral (24 h)."
    );
  });

  test("the drawer across rate periods: ~ where a rate changed; with a gap, its hours unpriced", () => {
    // inductor's hour on each of Nov 7–10 on two L4 runner labels: FAKE
    // weekly's rates change on Nov 9; the gap file leaves Nov 2–8 out.
    const crossing: CostOwners = {
      ...OWNERS,
      from: "2026-11-07",
      to: "2026-11-10",
      days: ["2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10"],
      rows: [
        { ...OWNERS.rows[0], runner_hours: 4 },
        { ...OWNERS.rows[0], label: "mt-l-x86iavx512-16-128", runner_hours: 4 },
      ],
      cells: [0, 1, 2, 3].flatMap((d) =>
        [0, 1].map((r) => [d, r, 1] as [number, number, number])
      ),
    };
    const drawer = (pricer: typeof WEEKLY) => {
      const model = ownerBarsModel(crossing, { pricer, trail: [] });
      const row = {
        key: "inductor",
        label: "inductor",
        owners: ["inductor"],
        hours: model.view.ownerScope.get("inductor") ?? 0,
        kind: "owner" as const,
      };
      let r!: ReactTestRenderer;
      act(() => {
        r = create(
          <RunnersDrawer
            model={model}
            row={row}
            scopeLabel="all workflows"
            onClose={() => {}}
          />,
          { createNodeMock: nodeMock }
        );
      });
      return r;
    };
    current = drawer(WEEKLY);
    expect(tableRows(current)).toEqual([
      ["Machine · runner", "Runner-hours", "$/h", "$", "Share"],
      ["NVIDIA L4", "8 h", "~$0.30/h", "$2", "100%"],
      ["mt-l-x86aavx2-11-41-l4", "4 h", "~$0.50/h", "$2", "83%"],
      ["mt-l-x86iavx512-16-128", "4 h", "~$0.10/h", "<$1", "17%"],
    ]);
    act(() => current!.unmount());
    current = drawer(GAP);
    expect(prose(current)).toContain(
      "$1 · 100% of $1 · 8 runner-hours, 4 h unpriced"
    );
    expect(tableRows(current)).toEqual([
      ["Machine · runner", "Runner-hours", "Unpriced", "$/h", "$", "Share"],
      ["NVIDIA L4", "8 h", "4 h", "~$0.33/h", "$1", "100%"],
      ["mt-l-x86aavx2-11-41-l4", "4 h", "2 h", "$0.55/h", "$1", "83%"],
      ["mt-l-x86iavx512-16-128", "4 h", "2 h", "$0.11/h", "<$1", "17%"],
    ]);
  });

  test("B with no priced day: no rates, never $0", () => {
    const ctx = ctxOf("2026-11-20", "2026-12-07", "2026-12-08");
    current = render(props({ unit: "usd", pricer: WEEKLY, context: ctx }));
    expect(words(current)).toContain("No rates for B's days.");
  });
});

describe("states", () => {
  test("each in turn: error, no trend, B without data, loading, no rows", () => {
    mockState = "error";
    current = render(props());
    expect(words(current)).toContain("Could not load the usage by owner");
    act(() => current!.unmount());
    mockState = "ok";
    current = render(props({ context: null }));
    expect(words(current)).toContain("Loading the trend…");
    act(() => current!.unmount());
    const before = ctxOf("2026-11-20", "2026-11-30", "2026-12-01");
    const early = resolveCompare(
      query({ cmp: null, b: { from: "2026-11-11", to: "2026-11-17" } }),
      before
    );
    current = render(
      props({ context: before, compare: early, settled: early })
    );
    expect(words(current)).toContain("B has no data.");
    expect(words(current)).toContain("no data");
    act(() => current!.unmount());
    mockState = "loading";
    current = render(props());
    expect(words(current)).toContain("Loading usage by owner…");
    act(() => current!.unmount());
    mockState = "ok";
    mockRows = (a) => ({ ...a, rows: [], cells: [] });
    current = render(props({ scopeLabel: "PR Critical Path" }));
    expect(words(current)).toContain(
      "No test-job runner-hours in PR Critical Path on B's days."
    );
  });

  test("before the first client render (SSR): the band only, nothing asked", () => {
    const html = renderToStaticMarkup(<OwnerBarsPanel {...props()} />);
    expect(html).toContain("Usage by owner");
    expect(html).toContain("Loading usage by owner…");
    expect(mockAsked.every((u) => u === null)).toBe(true);
  });
});

describe("dark mode", () => {
  test("the first hued machine's dot takes the dark theme's hue, the page's position", () => {
    const dark = createTheme({ palette: { mode: "dark" } });
    const page = prepareRunnerHours(OWNERS);
    const colored = ["Apple M1", "NVIDIA L4"];
    const model = ownerBarsModel(
      { ...OWNERS, piece: null, cells: [] },
      { pricer: null, colored, trail: [] }
    );
    const html = renderToStaticMarkup(
      <ThemeProvider theme={dark}>
        <OwnerBars
          model={model}
          stale={false}
          scopeLabel="all workflows"
          onTogglePill={() => {}}
          onClear={() => {}}
        />
      </ThemeProvider>
    );
    const hue = machineHue(dark, { ...page, colored: [0] }, 0) as string;
    expect(html.toLowerCase()).toContain(hue.toLowerCase());
    const light = machineHue(
      createTheme({ palette: { mode: "light" } }),
      { ...page, colored: [0] },
      0
    ) as string;
    expect(html.toLowerCase()).not.toContain(light.toLowerCase());
  });
});
