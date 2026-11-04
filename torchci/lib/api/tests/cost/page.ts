import { parameterSchema } from "lib/api/parameters";
import {
  COST_WINDOWS,
  DEFAULT_COST_WINDOW,
} from "lib/api/tests/cost/windows";
import { z } from "zod/v4";

// The cost page, /tests/[organization]/[repo]/cost: runner-hours by owner
// split by machine, a workflows card and the owner-machine matrix, all from
// GET /api/tests/cost. workflow is the scope, the one choice that
// changes the numbers; owner and machine only highlight; split_by, cells and
// only are how it is drawn. Defined beside the endpoint as the hub's other
// pages are (pages/parameters.ts): the page reads and writes its URL with
// these (decodePageQuery, pageUrlParams) and the document lists the page
// from them. Zod and the registry only: the page imports this module into
// the browser.
export const COST_PAGE_PATH = "/tests/{organization}/{repo}/cost";

export function costPagePath(repo: string): string {
  return `/tests/${repo}/cost`;
}

export const SPLIT_BYS = ["none", "machine"] as const;
export type SplitBy = (typeof SPLIT_BYS)[number];

// What the matrix's cells show: an owner's share of the machine's
// runner-hours, the machine's share of the owner's, or the hours.
export const CELLS = ["machine", "owner", "hours"] as const;
export type Cells = (typeof CELLS)[number];
export const DEFAULT_CELLS: Cells = "machine";

export const COST_PAGE_PARAMETER_DEFINITIONS = {
  window: {
    encoding: "single",
    schema: z
      .enum(COST_WINDOWS)
      .default(DEFAULT_COST_WINDOW)
      .describe(
        "The last whole UTC days the page counts, as GET /api/tests/cost's window."
      ),
  },
  workflow: {
    encoding: "repeat",
    schema: z
      .array(z.string())
      .optional()
      .describe(
        "The workflows whose runner-hours the page counts, lowercase as GET /api/tests/cost names them; repeat the parameter for several. Every workflow when absent; pull and trunk are the PR Critical Path preset."
      ),
  },
  owner: {
    encoding: "repeat",
    schema: z
      .array(z.string())
      .optional()
      .describe(
        "Owners to highlight, as GET /api/tests/cost names them (a bucket such as shared:build included); repeat for several. It narrows nothing."
      ),
  },
  machine: {
    encoding: "repeat",
    schema: z
      .array(z.string())
      .optional()
      .describe(
        "Machines to highlight, as GET /api/tests/cost names them, Not probed for the hours on no known machine; repeat for several. It narrows nothing."
      ),
  },
  split_by: {
    encoding: "single",
    schema: z
      .enum(SPLIT_BYS)
      .default("machine")
      .describe(
        "machine splits each owner's bar by the machines its hours ran on; none draws plain bars."
      ),
  },
  cells: {
    encoding: "single",
    schema: z
      .enum(CELLS)
      .default(DEFAULT_CELLS)
      .describe(
        "What the matrix's cells show: machine, each owner's share of the machine's runner-hours; owner, each machine's share of the owner's; hours, the runner-hours."
      ),
  },
  only: {
    encoding: "single",
    schema: z
      .enum(["0", "1"])
      .default("0")
      .describe(
        "1 hides the matrix's rows and columns that are not highlighted; every number stays as it is."
      ),
  },
} as const;

export const CostPageQuerySchema = parameterSchema(
  COST_PAGE_PARAMETER_DEFINITIONS
);
export type CostPageQuery = z.infer<typeof CostPageQuerySchema>;
