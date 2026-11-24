import {
  casesEcho,
  childBy,
  type CostCases,
  costCasesUrl,
  type CostScope,
  costScopeUrl,
  current,
  type Dim,
  type DrillInput,
  type DrillModelBase,
  type DrillQuery,
  type Hover,
  namedOwners,
  type Pill,
  rootOf,
  type ScopeBy,
  type ScopeChildInfo,
  scopeEcho,
} from "lib/api/tests/cost/contracts";
import {
  appendPill,
  type CasesView,
  casesView,
  changeSentence,
  chooseRoot,
  climbTo,
  type DrillRow,
  dropPill,
  flipPills,
  laneGroups,
  type LevelView,
  levelView,
  nextDim,
  parentName,
  type Phrase,
  pillName,
  rowByKey,
  scopeName,
  scopeTitle,
  sideChips,
  structuralTrail,
  swapPill,
  testsListHref,
  validTrail,
} from "lib/tests/cost/drill";
import { useSettled } from "lib/tests/cost/useSettled";
import { requestJson } from "lib/tests/request";
import { useApiResource } from "lib/tests/useApiResource";
import { useCallback, useEffect, useMemo, useState } from "react";

// One /scope level: the answer for its URL, the one kept from the last URL
// while it loads (drawn dimmed, never acted on), and its rows.
export interface LevelState {
  url: string | null;
  current: CostScope | undefined;
  view: LevelView | null; // of the current answer, else the kept one
  stale: boolean; // view is of a kept answer
  loading: boolean; // no current answer yet
  error: unknown;
  retry: () => void;
}

export interface PillView {
  k: number; // -1: the root pill
  pill: Pill | null;
  name: string;
  row: DrillRow | null; // the pill's scope; null while unknown
  stale: boolean;
  last: boolean;
}

export interface HeadModel {
  title: string;
  context: string;
  previewing: string | null; // the previewed sibling's name
  scope: DrillRow | null;
  parentName: string;
  share: number | null; // B of the scope ÷ B of its parent
  root: boolean;
  pushes: { a: number | null; b: number | null } | null; // pushes to main a day (root)
  sentence: Phrase[] | null;
  chips: string[];
  stale: boolean;
  fileLevel: boolean;
}

export interface CasesState {
  available: boolean; // a file and a machine are pinned
  file: string | null;
  machine: string | null;
  asked: boolean; // DrillQuery.tests
  url: string | null;
  answer: CostCases | undefined; // current only
  view: CasesView | null;
  loading: boolean;
  error: unknown;
  retry: () => void;
  environment: string | null; // "Try one environment"
  setEnvironment: (_env: string | null) => void;
  since: number | null; // when the current request started (elapsed)
}

export interface Preview {
  k: number; // pill k swapped, or trail.length for a "+ next" pick
  value: string;
}

export interface DrillModel extends DrillModelBase {
  input: DrillInput;
  root: "o" | "m";
  trail: Pill[];
  levels: LevelState[]; // pill k's siblings: /scope(trail[0..k), trail[k].dim)
  canvas: LevelState; // /scope(trail, childBy(trail, root)); the table at the root
  canvasBy: ScopeBy;
  table: LevelState; // the siblings of the last pill; the canvas at the root
  pills: PillView[];
  next: Dim | null;
  head: HeadModel;
  preview: Preview | null;
  hover: Hover | null;
  machineInfo: ScopeChildInfo | undefined;
  testsHref: string | null;
  // The owners the bars name when they stack owners, for the rows'
  // swatches; null when the bars stack something else.
  namedOwners: readonly string[] | null;
  cases: CasesState;
  // A row opened in place asks /scope(trail, by) through these: the same
  // repo, workflows, A/B and fetcher as the trail's levels.
  scopeUrl: (_trail: readonly Pill[], _by: ScopeBy) => string | null;
  fetchScope: (_url: string) => Promise<CostScope>;
  // Gestures. Each writes the URL through onQueryChange.
  climbTo: (_k: number) => void;
  climbOne: () => void;
  drop: (_k: number) => void;
  flip: (_k: number) => void;
  swap: (_k: number, _value: string) => void;
  append: (_pill: Pill) => void;
  focus: (_trail: Pill[]) => void; // Focus on a row opened in place: its whole scope
  setRoot: (_root: "o" | "m") => void;
  setPreview: (_preview: Preview | null) => void;
  setHover: (_hover: Hover | null) => void;
  set: (_patch: Partial<DrillQuery>) => void;
}

const MAX_LEVELS = 3; // one pill per dimension

export function useLevel(
  url: string | null,
  fetcher: (_url: string) => Promise<CostScope>,
  opts: Pick<DrillInput, "unit" | "per" | "pricer" | "rollup">
): LevelState {
  const res = useApiResource<CostScope>(
    url,
    { keepPreviousData: true },
    fetcher
  );
  const now = current(res.data, url, scopeEcho);
  // A kept answer of another dimension (the hook's last URL listed owners,
  // this one machines) would draw the wrong rows: skeleton instead.
  const by =
    url === null ? null : new URL(url, "http://x").searchParams.get("by");
  const kept =
    res.data !== undefined && res.data.by === by ? res.data : undefined;
  const shown = url === null ? undefined : now ?? kept;
  const { unit, per, pricer, rollup } = opts;
  const view = useMemo(
    () => (shown ? levelView(shown, { unit, per, pricer, rollup }) : null),
    [shown, unit, per, pricer, rollup]
  );
  return {
    url,
    current: now,
    view,
    stale: shown !== undefined && now === undefined,
    loading: url !== null && now === undefined,
    error: res.error,
    retry: () => void res.retry(),
  };
}

// The drill's state from the URL's DrillQuery and the settled A/B: one /scope
// per pill plus the canvas (at most 4), one /cases when asked, and the
// pills, head, table and bars scope they make.
export function useDrill(
  input: DrillInput,
  options: { fetcher?: (_url: string) => Promise<unknown> } = {}
): DrillModel {
  const {
    repo,
    workflows,
    compare,
    query,
    onQueryChange,
    per,
    rollup,
    pricer,
  } = input;
  const unit = pricer === null ? "hours" : input.unit;
  const fetcher = (options.fetcher ?? requestJson) as (
    _url: string
  ) => Promise<CostScope>;
  const trail = query.trail;
  const root = rootOf(trail, query.root);
  const canvasBy = childBy(trail, root);
  // In $, day pieces: each lies in one rate period, so a piece's rate is its
  // day's. The request says only that $ is on.
  const span = unit === "usd" ? "day" : "week";
  const urlOf = (pills: readonly Pill[], by: ScopeBy) =>
    repo && compare
      ? costScopeUrl(repo, workflows, compare.a, compare.b, pills, by, span)
      : null;
  const opts = { unit, per, pricer, rollup };
  // Fixed hook count: three levels and the canvas, null URLs when unused.
  const level0 = useLevel(
    trail.length > 0 ? urlOf([], trail[0].dim) : null,
    fetcher,
    opts
  );
  const level1 = useLevel(
    trail.length > 1 ? urlOf(trail.slice(0, 1), trail[1].dim) : null,
    fetcher,
    opts
  );
  const level2 = useLevel(
    trail.length > 2 ? urlOf(trail.slice(0, 2), trail[2].dim) : null,
    fetcher,
    opts
  );
  const levels = [level0, level1, level2].slice(
    0,
    Math.min(trail.length, MAX_LEVELS)
  );
  const canvas = useLevel(urlOf(trail, canvasBy), fetcher, opts);
  const table = trail.length === 0 ? canvas : levels[levels.length - 1];

  const [preview, setPreview] = useState<Preview | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [environment, setEnvironment] = useState<string | null>(null);

  // Drop dead pills once their levels answer.
  useEffect(() => {
    const next = validTrail(
      trail,
      [level0.current, level1.current, level2.current].slice(0, trail.length)
    );
    if (next !== null) onQueryChange({ trail: next });
    // onQueryChange is the page's writer; the trail and the answers drive this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trail, level0.current, level1.current, level2.current]);

  // A trail change clears what belonged to the old scope.
  const trailKey = JSON.stringify(trail);
  useEffect(() => {
    setPreview(null);
    setHover(null);
  }, [trailKey]);

  const write = useCallback(
    (next: Pill[], extra: Partial<DrillQuery> = {}) => {
      const pinned = (t: readonly Pill[], dim: Dim) =>
        t.find((p) => p.dim === dim)?.value ?? null;
      const fileMoved =
        pinned(next, "f") !== pinned(trail, "f") ||
        pinned(next, "m") !== pinned(trail, "m");
      setPreview(null);
      setEnvironment((e) => (fileMoved ? null : e));
      onQueryChange({
        trail: next,
        ...(fileMoved ? { tests: false, cfg: null, cases: null } : {}),
        ...extra,
      });
    },
    [trail, onQueryChange]
  );

  // ── Pills ──
  const pills: PillView[] = [
    {
      k: -1,
      pill: null,
      name: scopeName([], root),
      row:
        trail.length === 0
          ? canvas.view?.total ?? null
          : levels[0]?.view?.total ?? null,
      stale: trail.length === 0 ? canvas.stale : levels[0]?.stale ?? true,
      last: trail.length === 0,
    },
    ...trail.map((pill, k) => ({
      k,
      pill,
      name: pillName(pill),
      row: rowByKey(levels[k]?.view ?? null, pill.value),
      stale: levels[k]?.stale ?? true,
      last: k === trail.length - 1,
    })),
  ];

  // ── Bars ──
  // A previewed sibling stands in for pill k and keeps the deeper pills, as a
  // click would (validity drops them later); a "+ next" preview appends.
  const previewTrail =
    preview === null
      ? null
      : preview.k < trail.length
      ? swapPill(trail, preview.k, preview.value)
      : [...trail, { dim: nextDim(trail, root) as Dim, value: preview.value }];
  // Its own row sits in the last level of the previewed trail: loaded unless
  // a pill above the last is swapped, then asked once the hover settles.
  const previewLevelUrl = useSettled(
    previewTrail !== null && preview !== null && preview.k < trail.length - 1
      ? urlOf(
          previewTrail.slice(0, -1),
          previewTrail[previewTrail.length - 1].dim
        )
      : null,
    300,
    String
  );
  const previewLevel = useLevel(previewLevelUrl, fetcher, opts);
  const barsTrail = previewTrail ?? trail;
  const barsRoot = rootOf(barsTrail, root);
  const bars = {
    trail: barsTrail,
    root: barsRoot,
    by: childBy(barsTrail, barsRoot),
    fromTrend: barsTrail.length === 0 && barsRoot === "o",
    preview: previewTrail !== null,
    hover: previewTrail === null ? hover : null,
  };

  // ── Head ──
  const head = useMemo((): HeadModel => {
    if (preview !== null && previewTrail !== null) {
      const source =
        preview.k === trail.length
          ? canvas.view
          : preview.k === trail.length - 1
          ? levels[preview.k]?.view
          : previewLevel.current
          ? previewLevel.view
          : null;
      const row = rowByKey(
        source ?? null,
        previewTrail[previewTrail.length - 1].value
      );
      const { title, context } = scopeTitle(previewTrail, root);
      return {
        title,
        context,
        previewing: pillName(
          previewTrail[Math.min(preview.k, previewTrail.length - 1)]
        ),
        scope: row,
        parentName: parentName(previewTrail, root),
        share:
          row?.b != null && source?.total.b ? row.b / source.total.b : null,
        root: false,
        pushes: null,
        sentence: null,
        chips: [],
        stale: source === undefined || source === null,
        fileLevel: previewTrail.some((p) => p.dim === "f"),
      };
    }
    const { title, context } = scopeTitle(trail, root);
    const parent = trail.length === 0 ? null : table.view;
    const scope =
      trail.length === 0
        ? canvas.view?.total ?? null
        : rowByKey(table.view ?? null, trail[trail.length - 1].value);
    const children = !canvas.view
      ? []
      : canvasBy === "lane"
      ? laneGroups(canvas.view).groups.map((g) => g.row)
      : canvas.view.rows.filter((r) => !r.hidden);
    const basis = canvas.view ?? table.view;
    const d = basis?.figures.divisors;
    return {
      title,
      context,
      previewing: null,
      scope,
      parentName: parentName(trail, root),
      share:
        parent && scope?.b != null && parent.total.b
          ? scope.b / parent.total.b
          : null,
      root: trail.length === 0,
      pushes:
        trail.length === 0 && d
          ? {
              a: d[0].days > 0 ? d[0].pushes / d[0].days : null,
              b: d[1].days > 0 ? d[1].pushes / d[1].days : null,
            }
          : null,
      sentence:
        scope && basis && !canvas.stale && !table.stale
          ? changeSentence({
              name: scopeName(trail, root),
              scope,
              children: canvas.view && !canvas.stale ? children : [],
              unit,
              per,
              rollup,
              aHasDays: basis.aHasDays,
            })
          : null,
      chips: basis ? sideChips(basis) : [],
      stale: trail.length === 0 ? canvas.stale : table.stale,
      fileLevel: trail.some((p) => p.dim === "f"),
    };
    // previewTrail follows preview and trail
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    preview,
    trail,
    root,
    table.view,
    table.stale,
    canvas.view,
    canvas.stale,
    canvasBy,
    previewLevel.view,
    previewLevel.current,
    unit,
    per,
    rollup,
    level0.view,
    level1.view,
    level2.view,
  ]);

  // ── Owner swatches: only while the bars stack owners ──
  const ownerRanked =
    bars.by === "o" && canvas.view?.answer.by === "o" && !bars.preview
      ? [...canvas.view.rows]
          .sort((x, y) => (y.b ?? 0) - (x.b ?? 0))
          .map((r) => r.key)
      : null;
  const named = ownerRanked && repo ? namedOwners(repo, ownerRanked) : null;

  // ── Machine info and the tests list ──
  const mAt = trail.findIndex((p) => p.dim === "m");
  const machineInfo =
    mAt < 0
      ? undefined
      : (() => {
          const v = levels[mAt]?.view;
          const c = v?.answer.children.indexOf(trail[mAt].value) ?? -1;
          return c >= 0 ? v?.answer.info[c] : undefined;
        })();
  const testsHref = repo ? testsListHref(repo, trail, machineInfo) : null;

  // ── Cases ──
  const file = trail.find((p) => p.dim === "f")?.value ?? null;
  const machine = trail.find((p) => p.dim === "m")?.value ?? null;
  const available = file !== null && machine !== null;
  const casesUrl =
    available && query.tests && repo && compare
      ? costCasesUrl(
          repo,
          file as string,
          machine as string,
          compare.a,
          compare.b,
          environment ?? undefined
        )
      : null;
  const casesRes = useApiResource<CostCases>(
    casesUrl,
    {},
    fetcher as unknown as (_url: string) => Promise<CostCases>
  );
  const casesAnswer = current(casesRes.data, casesUrl, casesEcho);
  const casesViewed = useMemo(
    () =>
      casesAnswer && casesAnswer.status === "ok"
        ? casesView(casesAnswer)
        : null,
    [casesAnswer]
  );
  const [since, setSince] = useState<number | null>(null);
  useEffect(() => {
    setSince(
      casesUrl !== null && casesAnswer === undefined ? Date.now() : null
    );
    // restart the clock per request
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [casesUrl, casesAnswer === undefined]);

  const set = useCallback(
    (patch: Partial<DrillQuery>) => onQueryChange(patch),
    [onQueryChange]
  );

  return {
    bars,
    input: { ...input, unit },
    root,
    trail,
    levels,
    canvas,
    canvasBy,
    table,
    pills,
    next: nextDim(trail, root),
    head,
    preview,
    hover,
    machineInfo,
    testsHref,
    namedOwners: named,
    scopeUrl: urlOf,
    fetchScope: fetcher,
    cases: {
      available,
      file,
      machine,
      asked: query.tests,
      url: casesUrl,
      answer: casesAnswer,
      view: casesViewed,
      loading:
        casesUrl !== null && casesAnswer === undefined && !casesRes.error,
      error: casesRes.error,
      retry: () => void casesRes.retry(),
      environment,
      setEnvironment,
      since,
    },
    climbTo: (k) => write(climbTo(trail, k)),
    climbOne: () => trail.length > 0 && write(climbTo(trail, trail.length - 2)),
    drop: (k) => write(dropPill(trail, k)),
    flip: (k) => write(flipPills(trail, k)),
    swap: (k, value) => write(swapPill(trail, k, value)),
    append: (pill) => write(appendPill(trail, pill)),
    focus: (next) => write(structuralTrail(next)),
    setRoot: (r) => {
      const next = chooseRoot(trail, r);
      write(next.trail, { root: next.root });
    },
    setPreview,
    setHover,
    set,
  };
}
