import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import {
  Box,
  Button,
  ButtonBase,
  Link,
  Typography,
  useTheme,
} from "@mui/material";
import KeyButton from "components/tests/cost/KeyButton";
import LoadError from "components/tests/LoadError";
import TestName from "components/tests/TestName";
import { CASES_TOP } from "lib/api/tests/cost/contracts";
import { testsPagePath } from "lib/api/tests/pages/parameters";
import type { EnvironmentRecord, TestHealthEntry } from "lib/api/tests/types";
import {
  CASE_VIEW_LABELS,
  CASE_VIEW_ORDER,
  CASES_PAGE,
  casesSummary,
  caseViewKey,
  changeText,
  configGroups,
  configName,
  countText,
  deltaText,
  durText,
  environmentText,
  environmentTokenTexts,
  fileShort,
  filterCases,
  rangeText,
  shareText,
  testHoursText,
  type CaseRow,
  type LaneGroup,
} from "lib/tests/cost/drill";
import type { TestsFacet } from "lib/tests/facets";
import { headerBandColor, headerBandHoverColor } from "lib/tests/headerColors";
import { testRunsHref } from "lib/tests/links";
import { useEffect, useState } from "react";
import { DrillBand, drillColors, MiniMark, toneOf } from "./ButterflyRow";
import type { CasesState, DrillModel } from "./useDrill";

const CONFIG_GRID =
  "minmax(0,2fr) 56px minmax(56px,0.8fr) 60px 60px 72px 68px 120px 104px 84px 24px";
const CASE_GRID =
  "minmax(0,3fr) minmax(0,1.4fr) minmax(0,1fr) 104px 96px 104px 92px 84px 72px 24px";

// The tests list narrowed to a file and a configuration's environment and
// test config, rolling 14 days over main and pull requests.
function configListHref(
  repo: string,
  file: string,
  row: CaseRow | null
): string {
  const search = new URLSearchParams({ file });
  const e = row?.environment;
  if (e) {
    const facets: Partial<Record<TestsFacet, string>> = {
      accelerator: e.accelerator,
      accelerator_version: e.accelerator_version,
      device_name: e.device_name,
      python_version: e.python_version,
      os: e.os,
      cpu_architecture: e.cpu_architecture,
      cpu_capability: e.cpu_capability,
      cc_compiler: e.cc_compiler,
      cc_compiler_version: e.cc_compiler_version,
    };
    for (const [k, v] of Object.entries(facets)) {
      if (v) search.set(k, v);
    }
  }
  const config = row?.envVars?.values.TEST_CONFIG;
  const configFacet: TestsFacet = "test_config";
  if (config) search.set(configFacet, config);
  search.set("window", "14d");
  search.set("ran_on", "main,pull_request");
  return `${testsPagePath(repo)}?${search}`;
}

function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.round((now - since) / 1000));
}

function LaneChoices({
  cases,
  lanes,
  only,
}: {
  cases: CasesState;
  lanes: readonly LaneGroup[];
  only?: readonly string[]; // environments the gate lets through
}) {
  const choices = lanes.filter(
    (l) => only === undefined || only.includes(l.envId)
  );
  if (choices.length === 0) return null;
  return (
    <Box
      sx={{
        display: "flex",
        flexWrap: "wrap",
        gap: 1,
        alignItems: "center",
        mt: 0.75,
      }}
    >
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        Try one environment:
      </Typography>
      {choices.map((l) => (
        <KeyButton
          key={l.envId}
          title={
            l.environment
              ? environmentText(l.environment)
              : `environment ${l.envId}`
          }
          active={cases.environment === l.envId}
          onClick={() => cases.setEnvironment(l.envId)}
        >
          {l.name}
        </KeyButton>
      ))}
    </Box>
  );
}

// A scan's estimate in words: "about 46 min", "about 2.1 h", "about 40 s".
export function scanTime(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

// Configurations and test cases of a file on a machine: behind a button,
// since the scan reads ci.runs (11–37 s). A gate answers first: a file too
// big to scan offers one environment at a time and the tests list.
// Configurations are exact; cases are the 200 largest moves.
export default function CasesPanel({
  drill,
  lanes,
}: {
  drill: DrillModel;
  lanes: readonly LaneGroup[];
}) {
  const theme = useTheme();
  const c = drillColors(theme);
  const { cases } = drill;
  const { query } = drill.input;
  const repo = drill.input.repo ?? "";
  const [limit, setLimit] = useState(CASES_PAGE);
  const elapsed = useElapsed(cases.loading ? cases.since : null);
  if (!cases.available || cases.file === null) return null;
  const file = cases.file;
  const caption = (
    <Typography
      variant="caption"
      component="p"
      sx={{ color: "text.secondary", mt: 0.75 }}
    >
      Test-level figures: per day, all workflows and triggers, last 14 days;
      files too big to scan are left out.
    </Typography>
  );
  if (!cases.asked) {
    return (
      <Box sx={{ mt: 1 }}>
        <Button
          variant="outlined"
          size="small"
          onClick={() => drill.set({ tests: true })}
          sx={{ textTransform: "none" }}
        >
          Load configurations and test cases · last 14 days
        </Button>
      </Box>
    );
  }
  if (cases.error) {
    return (
      <Box sx={{ mt: 1 }}>
        <LoadError
          what="configurations and test cases"
          error={cases.error}
          onRetry={cases.retry}
        />
        <LaneChoices cases={cases} lanes={lanes} />
      </Box>
    );
  }
  if (!cases.answer) {
    return (
      <Box sx={{ mt: 1, display: "flex", alignItems: "center", gap: 1 }}>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          Loading configurations and test cases… {elapsed} s
        </Typography>
        <Button
          size="small"
          onClick={() => drill.set({ tests: false })}
          sx={{ textTransform: "none" }}
        >
          Cancel
        </Button>
      </Box>
    );
  }
  const answer = cases.answer;
  if (answer.status === "too_big") {
    const pass = answer.lanes
      .filter((l) => !l.tooBig)
      .map((l) => l.environment);
    const worst = Math.max(0, ...answer.lanes.map((l) => l.estimate));
    return (
      <Box sx={{ mt: 1 }}>
        <Typography variant="body2">
          {fileShort(file)} has too many test runs on {cases.machine} to scan at
          once
          {worst > 0
            ? ` (about ${scanTime(
                answer.lanes.reduce((t, l) => t + l.estimate, 0)
              )})`
            : ""}
          .{" "}
          <Link href={configListHref(repo, file, null)} underline="hover">
            Open it in the tests list ↗
          </Link>
        </Typography>
        {pass.length > 0 ? (
          <LaneChoices cases={cases} lanes={lanes} only={pass} />
        ) : (
          <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>
            Each environment is too big to scan on its own as well.
          </Typography>
        )}
        {caption}
      </Box>
    );
  }
  const view = cases.view;
  if (view === null) return null;
  const chips: string[] = [];
  const cover = (side: "A" | "B", s: typeof answer.a) => {
    const asked =
      Math.round(
        (Date.parse(`${s.to}T00:00:00Z`) - Date.parse(`${s.from}T00:00:00Z`)) /
          864e5
      ) + 1;
    if (s.covered_days === 0) {
      chips.push(
        `${side} is older than ci.runs keeps (14 days): configurations and cases show ${
          side === "A" ? "B" : "A"
        } only`
      );
    } else if (s.covered_days < asked && s.covered_from) {
      chips.push(
        `Test-level ${side} covers ${rangeText({
          from: s.covered_from,
          to: s.to,
        })} (${s.covered_days} of ${asked} days)`
      );
    }
  };
  cover("A", answer.a);
  cover("B", answer.b);
  const groups = configGroups(view);
  const common = (() => {
    const envs = groups
      .map((g) => g.environment)
      .filter((e): e is EnvironmentRecord => !!e);
    if (envs.length < 2) return [] as string[];
    const lists = envs.map(environmentTokenTexts);
    return lists[0].filter((t) => lists.every((l) => l.includes(t)));
  })();
  const envName = (e: EnvironmentRecord | null) =>
    e
      ? environmentTokenTexts(e)
          .filter((t) => !common.includes(t))
          .join(" · ") || environmentText(e)
      : "unknown environment";
  const topT = Math.max(
    1e-9,
    ...view.configs.flatMap((r) => [r.tA ?? 0, r.tB])
  );
  const viewKey = caseViewKey(query.cases);
  // A configuration the answer lacks (an old link) filters nothing.
  const cfgRow =
    query.cfg === null
      ? null
      : view.configs.find((r) => r.key === query.cfg) ?? null;
  const { rows, counts } = filterCases(view, {
    cfg: cfgRow?.key ?? null,
    view: viewKey,
    rank: query.rank,
  });
  const sum = casesSummary(rows);
  const run = query.rank !== "day";
  const head = {
    typography: "caption",
    color: "text.secondary",
    textAlign: "right",
    px: 0.75,
    lineHeight: 1.3,
  } as const;
  const numSx = {
    textAlign: "right",
    px: 0.75,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  } as const;
  const toneColor = (v: number | null) => {
    const t = toneOf(v);
    return t === "up" ? c.upText : t === "down" ? c.down : "text.secondary";
  };
  const chip = (active: boolean) => ({
    typography: "body2",
    height: 26,
    px: 1.25,
    borderRadius: "999px",
    whiteSpace: "nowrap",
    color: active ? theme.palette.primary.contrastText : "inherit",
    backgroundColor: active
      ? theme.palette.primary.main
      : headerBandColor(theme),
    "&:hover": {
      backgroundColor: active
        ? theme.palette.primary.dark
        : headerBandHoverColor(theme),
    },
    "&.Mui-focusVisible": {
      outline: `2px solid ${theme.palette.primary.main}`,
      outlineOffset: 2,
    },
  });
  const testHref = (r: CaseRow) =>
    r.test === null
      ? undefined
      : testRunsHref(
          repo,
          {
            test: { id: r.test.id } as TestHealthEntry["test"],
            environment: r.environment as TestHealthEntry["environment"],
            env_vars: r.envVars as TestHealthEntry["env_vars"],
          },
          { window: "14d", ranOn: ["main", "pull_request"] }
        );

  return (
    <Box sx={{ mt: 1.5 }}>
      {chips.length > 0 && (
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, mb: 1 }}>
          {chips.map((t) => (
            <Box
              key={t}
              component="span"
              sx={{
                typography: "caption",
                color: "text.secondary",
                border: `1px solid ${theme.palette.divider}`,
                borderRadius: "999px",
                px: 1,
                py: 0.25,
              }}
            >
              {t}
            </Box>
          ))}
        </Box>
      )}
      <DrillBand small title="Configurations · test time a day" />
      <Box role="table" aria-label="Configurations">
        <Box
          role="row"
          sx={{
            display: "grid",
            gridTemplateColumns: CONFIG_GRID,
            alignItems: "end",
            pb: 0.25,
            borderBottom: `1px solid ${theme.palette.divider}`,
          }}
        >
          <Box sx={{ ...head, textAlign: "left" }}>Test config</Box>
          <Box sx={head}>Cases</Box>
          <Box sx={{ ...head, textAlign: "left" }}>A | B</Box>
          <Box sx={head}>A</Box>
          <Box sx={head}>B</Box>
          <Box sx={head}>Change</Box>
          <Box sx={head}>%</Box>
          <Box sx={head}>
            Per file run
            <br />A → B
          </Box>
          <Box sx={head}>
            Skipped
            <br />A → B
          </Box>
          <Box sx={head}>
            Failed
            <br />A → B
          </Box>
          <Box />
        </Box>
        {groups.map((g) => (
          <Box key={g.envId}>
            <Box
              sx={{
                typography: "caption",
                color: "text.secondary",
                pt: 0.75,
                fontWeight: 600,
              }}
            >
              {envName(g.environment)}
            </Box>
            {g.configs.map((r) => {
              const on = query.cfg === r.key;
              return (
                <Box
                  key={r.key}
                  role="row"
                  tabIndex={0}
                  aria-selected={on}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("a")) return;
                    drill.set({ cfg: on ? null : r.key });
                    setLimit(CASES_PAGE);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      drill.set({ cfg: on ? null : r.key });
                    }
                  }}
                  sx={{
                    display: "grid",
                    gridTemplateColumns: CONFIG_GRID,
                    alignItems: "center",
                    minHeight: 26,
                    typography: "body2",
                    cursor: "pointer",
                    backgroundColor: on ? c.selected : undefined,
                    "&:hover": { backgroundColor: on ? c.selected : c.hover },
                    "&:focus-visible": {
                      outline: `2px solid ${theme.palette.primary.main}`,
                      outlineOffset: -2,
                    },
                  }}
                >
                  <Box
                    sx={{
                      pl: 1.5,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={
                      r.envVars
                        ? Object.entries(r.envVars.values)
                            .map(([k, v]) => `${k}=${v}`)
                            .join("\n")
                        : undefined
                    }
                  >
                    <b>{configName(r.envVars)}</b>
                    {r.envVars && Object.keys(r.envVars.values).length > 1 && (
                      <Box
                        component="span"
                        sx={{
                          color: "text.secondary",
                          ml: 0.75,
                          typography: "caption",
                        }}
                      >
                        +{Object.keys(r.envVars.values).length - 1}
                      </Box>
                    )}
                  </Box>
                  <Box sx={{ ...numSx, color: "text.secondary" }}>
                    {countText(Math.max(r.testsA, r.testsB))}
                  </Box>
                  <Box sx={{ pr: 1 }}>
                    <MiniMark a={r.tA} b={r.tB} top={topT} />
                  </Box>
                  <Box sx={{ ...numSx, color: "text.secondary" }}>
                    {testHoursText(r.tA)}
                  </Box>
                  <Box sx={{ ...numSx, fontWeight: 600 }}>
                    {testHoursText(r.tB)}
                  </Box>
                  <Box sx={{ ...numSx, color: toneColor(r.d) }}>
                    {r.d === null ? "" : deltaText("hours", r.d)}
                  </Box>
                  <Box sx={{ ...numSx, color: toneColor(r.d) }}>
                    {changeText({ a: r.tA, b: r.tB })}
                  </Box>
                  <Box sx={{ ...numSx, color: "text.secondary" }}>
                    {durText(r.prA)} → {durText(r.prB)}
                  </Box>
                  <Box
                    sx={{
                      ...numSx,
                      color:
                        (r.skB ?? 0) - (r.skA ?? 0) >= 0.2
                          ? "text.primary"
                          : "text.secondary",
                      fontWeight:
                        (r.skB ?? 0) - (r.skA ?? 0) >= 0.2 ? 600 : 400,
                    }}
                  >
                    {shareText(r.skA)} → {shareText(r.skB)}
                  </Box>
                  <Box
                    sx={{ ...numSx, color: "text.secondary" }}
                    title={`Reruns ${r.A.reruns} → ${r.B.reruns}`}
                  >
                    {r.A.failed + r.B.failed === 0
                      ? "0"
                      : `${countText(r.A.failed)} → ${countText(r.B.failed)}`}
                  </Box>
                  <Link
                    href={configListHref(repo, file, r)}
                    underline="none"
                    aria-label="Open in the tests list"
                    sx={{ textAlign: "center" }}
                  >
                    ↗
                  </Link>
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>

      <Box sx={{ mt: 2 }}>
        <DrillBand
          small
          title={`Test cases of ${fileShort(file)} · test × configuration`}
          keys={
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
              <Typography
                variant="body2"
                sx={{ color: "text.secondary", mr: 0.5 }}
              >
                Rank by
              </Typography>
              <KeyButton
                title="The part of the change a day from each run taking more or less time; fewer runs don't count"
                active={run}
                onClick={() => drill.set({ rank: null })}
              >
                Change from time per run
              </KeyButton>
              <KeyButton
                title="All of the change in test time a day, fewer or more runs included"
                active={!run}
                onClick={() => drill.set({ rank: "day" })}
              >
                All change a day
              </KeyButton>
            </Box>
          }
        />
        <Box
          sx={{
            display: "flex",
            flexWrap: "wrap",
            gap: 1,
            alignItems: "center",
            mb: 0.75,
          }}
        >
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            Show
          </Typography>
          {CASE_VIEW_ORDER.map((v) => (
            <ButtonBase
              key={v}
              aria-pressed={viewKey === v}
              onClick={() => {
                drill.set({ cases: v === "moves" ? null : v });
                setLimit(CASES_PAGE);
              }}
              sx={chip(viewKey === v)}
            >
              {CASE_VIEW_LABELS[v]}
              <Box
                component="span"
                sx={{
                  ml: 0.75,
                  opacity: 0.75,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {counts[v]}
              </Box>
            </ButtonBase>
          ))}
          {cfgRow && (
            <Box
              component="span"
              sx={{
                display: "inline-flex",
                alignItems: "center",
                gap: 0.5,
                ml: "auto",
                typography: "body2",
                border: `1px solid ${theme.palette.divider}`,
                borderRadius: "999px",
                pl: 1.25,
                pr: 0.25,
                height: 26,
              }}
            >
              <Box component="span" sx={{ color: "text.secondary" }}>
                Configuration
              </Box>
              {configName(cfgRow.envVars)} · {envName(cfgRow.environment)}
              <ButtonBase
                aria-label="Show every configuration's cases"
                onClick={() => drill.set({ cfg: null })}
                sx={{ width: 22, height: 22, borderRadius: "999px" }}
              >
                <CloseRoundedIcon sx={{ fontSize: 14 }} />
              </ButtonBase>
            </Box>
          )}
        </Box>
        <Typography variant="body2" sx={{ color: "text.secondary", mb: 0.5 }}>
          Showing <b>{Math.min(rows.length, limit)}</b> of <b>{rows.length}</b>{" "}
          tests × configuration
          {view.aDays > 0 && sum.tA !== null && (
            <>
              {" "}
              · their test time{" "}
              <b>
                {testHoursText(sum.tA)} → {testHoursText(sum.tB)}
              </b>{" "}
              a day
              {sum.effVol !== null && sum.effRun !== null && (
                <>
                  :{" "}
                  <Box component="span" sx={{ color: toneColor(sum.effVol) }}>
                    {deltaText("hours", sum.effVol)}
                  </Box>{" "}
                  from {sum.effVol < 0 ? "fewer" : "more"} runs,{" "}
                  <Box component="span" sx={{ color: toneColor(sum.effRun) }}>
                    {deltaText("hours", sum.effRun)}
                  </Box>{" "}
                  from time per run
                </>
              )}
            </>
          )}
        </Typography>
        <Box role="table" aria-label={`Test cases of ${fileShort(file)}`}>
          <Box
            role="row"
            sx={{
              display: "grid",
              gridTemplateColumns: CASE_GRID,
              alignItems: "end",
              py: 0.5,
              bgcolor: headerBandColor(theme),
            }}
          >
            <Box sx={{ ...head, textAlign: "left" }}>Name</Box>
            <Box sx={{ ...head, textAlign: "left" }}>Environment</Box>
            <Box sx={{ ...head, textAlign: "left" }}>Test config</Box>
            <Box sx={head}>
              {run ? "Time per run" : "Test time a day"}
              <br />A → B
            </Box>
            <Box sx={head}>
              {run ? (
                <>
                  Change a day
                  <br />
                  from time per run
                </>
              ) : (
                <>Change a day</>
              )}
            </Box>
            <Box sx={head}>
              {run ? "Test time a day" : "Per run"}
              <br />A → B
            </Box>
            <Box sx={head}>
              Skipped
              <br />A → B
            </Box>
            <Box sx={head}>
              Runs a day
              <br />A → B
            </Box>
            <Box sx={head}>
              Failed
              <br />A → B
            </Box>
            <Box />
          </Box>
          {rows.slice(0, limit).map((r) => {
            const href = testHref(r);
            const move = run ? r.effRun : r.d;
            const a = run ? r.prA : r.tA;
            const b = run ? r.prB : r.tB;
            const fmt = run ? durText : testHoursText;
            const pctRun =
              a !== null && a > 0 && b !== null ? (b - a) / a : null;
            return (
              <Box
                key={r.key}
                role="row"
                sx={{
                  display: "grid",
                  gridTemplateColumns: CASE_GRID,
                  alignItems: "center",
                  py: 0.5,
                  typography: "body2",
                  borderBottom: `1px solid ${theme.palette.divider}`,
                }}
              >
                <Box
                  sx={{
                    minWidth: 0,
                    pl: 0.75,
                    pr: 1.5,
                    overflowWrap: "anywhere",
                  }}
                >
                  {r.test ? (
                    <TestName
                      test={{
                        file,
                        suite: r.test.suite,
                        case_name: r.test.name,
                      }}
                      href={href}
                    />
                  ) : (
                    "unknown test"
                  )}
                  {r.A.runs === 0 && r.B.runs > 0 && view.aDays > 0 && (
                    <Box
                      component="span"
                      sx={{
                        typography: "caption",
                        color: "text.secondary",
                        ml: 0.5,
                      }}
                    >
                      new in B
                    </Box>
                  )}
                </Box>
                <Box
                  sx={{
                    minWidth: 0,
                    typography: "caption",
                    color: "text.secondary",
                    lineHeight: 1.3,
                  }}
                >
                  {envName(r.environment)}
                </Box>
                <Box sx={{ minWidth: 0, fontWeight: 500 }}>
                  {configName(r.envVars)}
                </Box>
                <Box sx={numSx}>
                  {fmt(a)} → <b>{fmt(b)}</b>
                </Box>
                <Box
                  sx={{ ...numSx, color: toneColor(move), lineHeight: 1.25 }}
                >
                  {move === null ? "–" : deltaText("hours", move)}
                  <Box sx={{ typography: "caption" }}>
                    {run
                      ? pctRun === null
                        ? ""
                        : `${pctRun > 0 ? "+" : "−"}${Math.abs(
                            Math.round(pctRun * 100)
                          )}% a run`
                      : r.p === null
                      ? ""
                      : `${r.p > 0 ? "+" : "−"}${Math.abs(
                          Math.round(r.p * 100)
                        )}%`}
                  </Box>
                </Box>
                <Box sx={{ ...numSx, color: "text.secondary" }}>
                  {run
                    ? `${testHoursText(r.tA)} → ${testHoursText(r.tB)}`
                    : `${durText(r.prA)} → ${durText(r.prB)}`}
                </Box>
                <Box sx={{ ...numSx, color: "text.secondary" }}>
                  {shareText(r.skA)} → {shareText(r.skB)}
                </Box>
                <Box sx={{ ...numSx, color: "text.secondary" }}>
                  {countText(r.runsA)} → {countText(r.runsB)}
                </Box>
                <Box
                  sx={{
                    ...numSx,
                    color: r.B.failed > 0 ? "text.primary" : "text.secondary",
                  }}
                  title={`Reruns ${r.A.reruns} → ${r.B.reruns}`}
                >
                  {r.A.failed + r.B.failed === 0
                    ? "0"
                    : `${r.A.failed} → ${r.B.failed}`}
                </Box>
                {href ? (
                  <Link
                    href={href}
                    underline="none"
                    aria-label="Open the test's page with this configuration marked"
                    sx={{ textAlign: "center" }}
                  >
                    ↗
                  </Link>
                ) : (
                  <Box />
                )}
              </Box>
            );
          })}
          {rows.length === 0 && (
            <Typography variant="body2" sx={{ color: "text.secondary", py: 1 }}>
              No test cases match.
            </Typography>
          )}
        </Box>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 1.5,
            mt: 1,
          }}
        >
          {rows.length > limit && (
            <Button
              size="small"
              variant="outlined"
              onClick={() => setLimit((l) => l + CASES_PAGE)}
              sx={{ textTransform: "none" }}
            >
              Show {Math.min(CASES_PAGE, rows.length - limit)} more
            </Button>
          )}
          <Link
            href={configListHref(repo, file, cfgRow)}
            underline="hover"
            sx={{ typography: "body2" }}
          >
            All in the tests list ↗
          </Link>
        </Box>
        <Typography
          variant="caption"
          component="p"
          sx={{ color: "text.secondary", mt: 0.75 }}
        >
          {view.rankedOf > view.cells.length
            ? `Among the ${CASES_TOP} largest moves of ${view.rankedOf.toLocaleString(
                "en-US"
              )} tests × configuration; the rest are in the tests list. `
            : ""}
          Test-level figures: per day, all workflows and triggers, last 14 days.
        </Typography>
      </Box>
    </Box>
  );
}
