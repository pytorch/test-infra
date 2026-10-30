import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { testsPagePath } from "lib/api/tests/pages/parameters";
import type { TestLanguage } from "lib/api/tests/parameters";
import type { TestRecord } from "lib/api/tests/types";
import type { Detail } from "lib/tests/environment";

dayjs.extend(utc);

// The header of a test's page, /tests/[organization]/[repo]/test/[test_id]:
// the glue between a test record and what the header shows, kept free of
// React so it can be tested as plain functions.

// The face the header sets code in, the path, the suite, the node id and
// the test's id: the system's own monospace, as HUD's other code views use.
export const MONOSPACE_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

// A case name in its two parts: the name as declared in the code and the
// parameters the runner appended. "test_add_cpu_float32", declared as
// "test_add", is "test_add" and "_cpu_float32". An unparametrized test has
// no parameters, and so has one whose declared name is unknown (empty) or
// is not how the case name starts: the whole name is then the declared
// part, since nothing in it can be told apart.
export interface CaseNameParts {
  declared: string;
  parameters: string;
}

export function splitCaseName(
  test: Pick<TestRecord, "case_name" | "declared_case_name">
): CaseNameParts {
  const { case_name, declared_case_name } = test;
  if (
    declared_case_name !== "" &&
    declared_case_name.length < case_name.length &&
    case_name.startsWith(declared_case_name)
  ) {
    return {
      declared: declared_case_name,
      parameters: case_name.slice(declared_case_name.length),
    };
  }
  return { declared: case_name, parameters: "" };
}

// Where the test lives, as the path back to the list: the repository, to
// its tests; the file, to the tests searched for by its path, as a file
// clicked in the list's Name cell searches; the suite, to those searched
// for by file and suite together, which the list's search, matching
// anywhere in the node id, narrows to that one suite. A module-level
// function has no suite crumb.
export interface Crumb {
  text: string;
  href: string;
}

export function headerCrumbs(
  test: Pick<TestRecord, "repo" | "file" | "suite">
): Crumb[] {
  const list = testsPagePath(test.repo);
  const searched = (text: string) =>
    `${list}?search=${encodeURIComponent(text)}`;
  const crumbs: Crumb[] = [
    { text: test.repo, href: list },
    { text: test.file, href: searched(test.file) },
  ];
  if (test.suite !== "") {
    crumbs.push({
      text: test.suite,
      href: searched(`${test.file}::${test.suite}`),
    });
  }
  return crumbs;
}

// When the catalog first saw the test, as a date in the viewer's zone,
// "Oct 24, 2026", with the time of day for the tooltip.
export function firstSeenLabel(timestamp: string): string {
  return dayjs.utc(timestamp).local().format("MMM D, YYYY");
}

export function firstSeenExact(timestamp: string): string {
  return dayjs.utc(timestamp).local().format("MMM D, YYYY h:mm a");
}

// The language pill's mark: GitHub's color for each language, which readers
// know from its repository listings (linguist: Python #3572A5, C++ #f34b7d);
// none for a language the catalog could not tell. Typed by the API's
// languages, so a new one without a color does not compile. The mark is a
// dot before the name, as GitHub sets it, not a tint of the pill: the hub
// keeps hue for status, the Health blocks, and a tinted pill would read as
// one more status.
export const LANGUAGE_COLORS: Record<TestLanguage, string | null> = {
  python: "#3572A5",
  cpp: "#f34b7d",
  unknown: null,
};

// The two names behind the headline, for its tooltip: the name as declared
// in the code and the name the runner selects, parameters included. A
// declared name the catalog does not know reads "unknown".
export function caseNameDetails(
  test: Pick<TestRecord, "case_name" | "declared_case_name">
): Detail[] {
  return [
    {
      name: "Declared name",
      value:
        test.declared_case_name === "" ? "unknown" : test.declared_case_name,
    },
    { name: "Case name", value: test.case_name },
  ];
}

// The one language value the page spells: the catalog's "unknown", which
// the options label "Unknown". Its pill then names what is unknown, since
// the label alone would not say. Typed by the API's languages, so the
// catalog dropping the value does not compile.
export const UNKNOWN_LANGUAGE: TestLanguage = "unknown";

// What a pill says for a value the catalog does not have, a file without
// owner labels: the word the options use for a language it could not tell.
export const UNKNOWN_VALUE = "Unknown";
