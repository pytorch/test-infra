import type { EnvironmentRecord, EnvVarsRecord } from "lib/api/tests/types";
import {
  ENVIRONMENT_COLUMN_FACETS,
  FACET_TITLES,
  facetChoice,
  FacetOptions,
  labelOf,
  PAIR_OF,
  pairText,
  TestsFacet,
} from "lib/tests/facets";
import { workflowName } from "lib/workflowName";

// How an environment and an env var set are set in their cells: a few tokens,
// each a thing with its version, that a click turns into the filters it
// stands for. Labels come from the options; without them the catalog's own
// spelling is shown.

export interface Token {
  text: string;
  // The facet values this token stands for; clicking it filters by them all.
  filters: Partial<Record<TestsFacet, string>>;
  // What hovering the token shows, when its text is short for something:
  // the workflow's full path behind its name.
  tooltip?: string;
}

function label(
  facet: TestsFacet,
  value: string,
  options: FacetOptions | undefined
): string {
  // An empty value has no label worth showing inside a token.
  return value === "" || options === undefined
    ? value
    : labelOf(value, facetChoice(options, facet).values);
}

export interface EnvironmentTokens {
  // Full strength: what torch was built for and what it ran on.
  primary: Token[];
  // Muted: the interpreter and the platform details.
  secondary: Token[];
}

// "CUDA 13.2 · NVIDIA H100 80GB HBM3 ×4" over "Python 3.11 · Linux 22.04 ·
// x86_64 avx2 · GCC 11.4"; a CPU build has no device token, "CPU" alone.
export function environmentTokens(
  environment: EnvironmentRecord,
  options: FacetOptions | undefined
): EnvironmentTokens {
  const pairs = PAIR_OF;
  const deviceCount = String(environment.device_count);
  const tokens = {
    accelerator: {
      text: pairText(
        pairs.accelerator,
        label("accelerator", environment.accelerator, options),
        environment.accelerator_version
      ),
      filters: {
        accelerator: environment.accelerator,
        accelerator_version: environment.accelerator_version,
      },
    },
    device: {
      text: pairText(pairs.device_name, environment.device_name, deviceCount),
      filters: {
        device_name: environment.device_name,
        device_count: deviceCount,
      },
    },
    python: {
      text:
        environment.python_version === ""
          ? ""
          : `Python ${environment.python_version}`,
      filters: { python_version: environment.python_version },
    },
    os: {
      text: pairText(
        pairs.os,
        label("os", environment.os, options),
        environment.os_version
      ),
      filters: { os: environment.os, os_version: environment.os_version },
    },
    cpu: {
      text: pairText(
        pairs.cpu_architecture,
        environment.cpu_architecture,
        environment.cpu_capability
      ),
      filters: {
        cpu_architecture: environment.cpu_architecture,
        cpu_capability: environment.cpu_capability,
      },
    },
    compiler: {
      text: pairText(
        pairs.cc_compiler,
        label("cc_compiler", environment.cc_compiler, options),
        environment.cc_compiler_version
      ),
      filters: {
        cc_compiler: environment.cc_compiler,
        cc_compiler_version: environment.cc_compiler_version,
      },
    },
  } satisfies Record<string, Token>;
  const present = (list: Token[]) => list.filter((token) => token.text !== "");
  return {
    primary: present([tokens.accelerator, tokens.device]),
    secondary: present([tokens.python, tokens.os, tokens.cpu, tokens.compiler]),
  };
}

export interface Detail {
  name: string;
  // The catalog's own value; a dash when empty.
  value: string;
}

// Every field of an environment, titled, in the order the cell sets them,
// for the tooltip that completes the cell.
export function environmentDetails(environment: EnvironmentRecord): Detail[] {
  return ENVIRONMENT_COLUMN_FACETS.map((field) => {
    const value = String(environment[field]);
    return { name: FACET_TITLES[field], value: value === "" ? "—" : value };
  });
}

// The variable the API's test_config parameter reads: the name the CI matrix
// gives the mode a test ran in.
export const CONFIG_VARIABLE = "TEST_CONFIG";

// The config token of an env var set, or null when the set does not record
// the variable.
export function configToken(envVars: EnvVarsRecord): Token | null {
  const value = envVars.values[CONFIG_VARIABLE];
  return value === undefined
    ? null
    : { text: value, filters: { test_config: value } };
}

// The calling workflows of a configuration as tokens, each by its file
// (workflowName, the rule GET /api/tests/options labels its values by too)
// with its full path behind it, each filtering by its path.
export function workflowTokens(workflowPaths: readonly string[]): Token[] {
  return workflowPaths.map((path) => ({
    text: workflowName(path),
    filters: { workflow_path: path },
    tooltip: path,
  }));
}

// How many characters of workflow names the cell's second line holds before
// the rest is counted instead of cut off: "periodic.yml · trunk.yml" fits,
// a pair of long names does not. Measured on 2026-10-25, a configuration on
// main has one workflow in 93% of rows and two in the rest, never more.
export const WORKFLOW_LINE_BUDGET = 24;

// The tokens a line of the given budget shows, in order, always at least
// one, and the rest, which it counts. A separator costs three characters.
export function fitTokens(
  tokens: readonly Token[],
  budget: number
): {
  shown: Token[];
  hidden: Token[];
} {
  let length = 0;
  let shown = 0;
  for (const token of tokens) {
    length += (shown > 0 ? 3 : 0) + token.text.length;
    if (shown > 0 && length > budget) {
      break;
    }
    shown += 1;
  }
  return { shown: tokens.slice(0, shown), hidden: tokens.slice(shown) };
}

// The owner labels of a test's file as tokens, each filtering by itself.
// They are shown as stored, without the "module: " prefix the API already
// drops: "nn", "core_tests", "linear algebra".
export function ownerTokens(owners: readonly string[]): Token[] {
  return owners.map((owner) => ({ text: owner, filters: { owner } }));
}

// How many characters of owner labels the Owners cell holds at the table's
// text size before the rest is counted: the longest label, "higher order
// operators", fits alone. Measured on 2026-10-25, 2,011 of 2,014 owned files
// have one label and three have two.
export const OWNER_LINE_BUDGET = 24;

// The set's variables as NAME=value lines: the config variable first, since
// it names the set, then the rest by name; the config left out when asked.
export function variableLines(
  envVars: EnvVarsRecord,
  { withoutConfig = false } = {}
): string[] {
  const rank = (name: string) => (name === CONFIG_VARIABLE ? 0 : 1);
  return Object.entries(envVars.values)
    .filter(([name]) => !(withoutConfig && name === CONFIG_VARIABLE))
    .sort(([a], [b]) =>
      rank(a) !== rank(b) ? rank(a) - rank(b) : a < b ? -1 : a > b ? 1 : 0
    )
    .map(([name, value]) => `${name}=${value}`);
}
