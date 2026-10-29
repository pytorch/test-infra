import type { TestOptions } from "lib/api/tests/options/types";

// The exact filters of GET /api/tests that the tests page offers from the
// options, by API parameter name, grouped by the column whose header offers
// them: the Health column's status, the Environment column's eleven fields,
// in the order its cell sets them, the Test Config column's test config and
// calling workflow, and the Owners column's owner. Only the names are known
// here; every value comes from GET /api/tests/options at run time.

export const HEALTH_COLUMN_FACETS = ["status"] as const;
export const ENVIRONMENT_COLUMN_FACETS = [
  "accelerator",
  "accelerator_version",
  "device_name",
  "device_count",
  "python_version",
  "os",
  "os_version",
  "cpu_architecture",
  "cpu_capability",
  "cc_compiler",
  "cc_compiler_version",
] as const;
export const CONFIG_COLUMN_FACETS = ["test_config", "workflow_path"] as const;
export const OWNER_COLUMN_FACETS = ["owner"] as const;
export const TESTS_FACETS = [
  ...HEALTH_COLUMN_FACETS,
  ...ENVIRONMENT_COLUMN_FACETS,
  ...CONFIG_COLUMN_FACETS,
  ...OWNER_COLUMN_FACETS,
] as const;
export type TestsFacet = (typeof TESTS_FACETS)[number];

// The options for the facets alone. Every facet must be a choice the options
// publish, or this does not compile.
export type FacetOptions = Pick<TestOptions, TestsFacet>;

// The chosen values of every facet; empty means no filter on it.
export type FacetValues = Record<TestsFacet, string[]>;

export type FacetChoice = {
  default: string[];
  values: { value: string; label: string }[];
};
const NO_CHOICE: FacetChoice = { default: [], values: [] };

// What the options offer for a facet. Options served before the facet
// existed, a browser's cache can hold them for a while after a deploy, offer
// nothing for it, so the facet filters nothing and labels nothing, and the
// page still shows.
export function facetChoice(
  options: Partial<FacetOptions>,
  facet: TestsFacet
): FacetChoice {
  return options[facet] ?? NO_CHOICE;
}

export function noFacetValues(): FacetValues {
  return Object.fromEntries(
    TESTS_FACETS.map((facet) => [facet, []])
  ) as unknown as FacetValues;
}

// What each facet is called where the page names it: the menus' section
// titles and the environment tooltip.
export const FACET_TITLES: Record<TestsFacet, string> = {
  status: "Health",
  accelerator: "Accelerator",
  accelerator_version: "Accelerator version",
  device_name: "Device",
  device_count: "Devices",
  os: "OS",
  os_version: "OS version",
  cpu_architecture: "CPU architecture",
  cpu_capability: "CPU capability",
  cc_compiler: "Compiler",
  cc_compiler_version: "Compiler version",
  python_version: "Python",
  test_config: "Test config",
  workflow_path: "Workflow",
  owner: "Owner",
};

// The facets that read as one token, a thing and its version or count: CUDA
// 13.2, Linux 22.04, x86_64 avx2, GCC 11.4, NVIDIA L4 ×4.
export const TOKEN_PAIRS = [
  ["accelerator", "accelerator_version"],
  ["device_name", "device_count"],
  ["os", "os_version"],
  ["cpu_architecture", "cpu_capability"],
  ["cc_compiler", "cc_compiler_version"],
] as const;
export type TokenPair = (typeof TOKEN_PAIRS)[number];

// The two halves of a pair as one token, an empty half left out: "CUDA
// 13.2", "CPU", "Linux 22.04". A device is named with its count only when
// there are several, "NVIDIA H100 80GB HBM3 ×4", and counted alone when it
// has no name, "4 devices"; no device at all is no token.
export function pairText(pair: TokenPair, first: string, second: string) {
  if (pair[0] === "device_name") {
    const count = Number(second);
    if (first === "") {
      return count > 0 ? `${count} device${count === 1 ? "" : "s"}` : "";
    }
    return count >= 2 ? `${first} ×${count}` : first;
  }
  return `${first} ${second}`.trim();
}

// The offered values among the chosen ones, in the options' order, without
// repeats. Whatever a URL or a menu does not offer is dropped.
export function menuOrder<Value extends string>(
  chosen: readonly string[],
  offered: readonly { value: Value }[]
): Value[] {
  return offered
    .map((option) => option.value)
    .filter((value) => chosen.includes(value));
}

// The label the options give a value; the value itself if they give none.
export function labelOf<Value extends string>(
  value: Value,
  offered: readonly { value: Value; label: string }[]
): string {
  return offered.find((option) => option.value === value)?.label ?? value;
}

// What a folded menu section says of its facet beside the facet's name:
// "Any" when nothing is chosen, the one chosen value as the options label it,
// "pull.yml", "CUDA", or how many are chosen, "2 chosen", when several are.
export function sectionSummary(
  chosen: readonly string[],
  offered: readonly { value: string; label: string }[]
): string {
  if (chosen.length === 0) {
    return "Any";
  }
  if (chosen.length === 1) {
    return labelOf(chosen[0], offered);
  }
  return `${chosen.length} chosen`;
}

// Items as a sentence lists them: "Python", "Python and C++", "Python, C++
// and Unknown".
export function phraseList(items: readonly string[]): string {
  if (items.length <= 1) {
    return items.join("");
  }
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// Alternatives as a sentence offers them: "3.11", "3.11 or 3.12", "3.11,
// 3.12 or 3.14t".
export function phraseAlternatives(items: readonly string[]): string {
  if (items.length <= 1) {
    return items.join("");
  }
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

// The chosen values of one facet, labelled as the options label them, as
// alternatives. The values are taken as they come, already in menu order from
// resolveTestsQuery; one the options do not label is said as it is.
function alternatives(
  facet: TestsFacet,
  filters: FacetValues,
  options: FacetOptions
): string {
  const { values } = facetChoice(options, facet);
  return phraseAlternatives(
    filters[facet].map((value) => labelOf(value, values))
  );
}

// A bare version or number chosen on its own needs its title to be
// understood, "Accelerator version 13.2", "Devices 4"; so does a Python
// version, "Python 3.11".
const TITLED_ALONE: readonly TestsFacet[] = [
  ...TOKEN_PAIRS.map((pair) => pair[1]),
  "python_version",
];

// The pairs by the facet that leads each: PAIR_OF.os is the OS pair.
export const PAIR_OF = Object.fromEntries(
  TOKEN_PAIRS.map((pair) => [pair[0], pair])
) as Record<TokenPair[0], TokenPair>;

// The pair a facet leads, if it leads one.
export function pairLedBy(facet: TestsFacet): TokenPair | undefined {
  return (PAIR_OF as Partial<Record<TestsFacet, TokenPair>>)[facet];
}

// What is chosen among some facets, as a header's filter says it: nothing
// when nothing is chosen; a pair chosen one value each as its token, "CUDA
// 13.2"; any other chosen facet as its alternatives, "NVIDIA L4 or Tesla
// T4", titled when it would be a bare number; the pieces joined by middle
// dots in the facets' order, "CUDA 13.2 · Python 3.11 · Linux".
export function facetsPhrase(
  facets: readonly TestsFacet[],
  filters: FacetValues,
  options: FacetOptions
): string {
  const pieces: string[] = [];
  const said = new Set<TestsFacet>();
  for (const facet of facets) {
    if (said.has(facet)) {
      continue;
    }
    const pair = pairLedBy(facet);
    if (
      pair !== undefined &&
      facets.includes(pair[1]) &&
      filters[pair[0]].length === 1 &&
      filters[pair[1]].length === 1 &&
      filters[pair[0]][0] !== ""
    ) {
      pieces.push(
        pairText(
          pair,
          labelOf(filters[pair[0]][0], facetChoice(options, pair[0]).values),
          filters[pair[1]][0]
        )
      );
      said.add(pair[1]);
      continue;
    }
    if (filters[facet].length === 0) {
      continue;
    }
    const words = alternatives(facet, filters, options);
    pieces.push(
      TITLED_ALONE.includes(facet) ? `${FACET_TITLES[facet]} ${words}` : words
    );
  }
  return pieces.join(" · ");
}
