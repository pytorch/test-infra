import { PaginationSchema } from "lib/api/schema";
import { z } from "zod/v4";

// Response schemas of the release endpoints. Every field has a description: the
// OpenAPI document is generated from them.

export const STEP_STATUSES = [
  "done",
  "blocked",
  "in_progress",
  "todo",
] as const;
export const ARTIFACT_VERDICTS = [
  "present",
  "missing",
  "size_anomalous",
  "unexpected",
] as const;
export const RELEASE_TYPES = ["minor", "patch"] as const;
export const TIERS = ["A", "S", "K", "M"] as const;

export const VersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, {
    error: "version must look like 2.16.0 (major.minor.patch)",
  })
  .describe("Release version, for example 2.16.0 or 2.15.1.");

const NextMilestoneSchema = z
  .object({
    name: z.string().describe("Branch cut, Final RC or GA."),
    date: z.string().describe("Planned date, YYYY-MM-DD."),
  })
  .nullable()
  .describe(
    "The next planned milestone that is today or later; null when none is dated or all have passed."
  );

const ReleaseStatusSchema = z
  .enum(STEP_STATUSES)
  .describe(
    "done when every step is done; blocked when a step is blocking; in_progress when some step has started; otherwise todo."
  );

const ReleaseIndexEntrySchema = z
  .object({
    version: VersionSchema,
    type: z
      .enum(RELEASE_TYPES)
      .describe("A release X.Y.0 is minor; X.Y.Z with Z above 0 is patch."),
    branch: z.string().describe("The release branch, release/X.Y."),
    ga_date: z
      .string()
      .nullable()
      .describe("The planned release date, YYYY-MM-DD; null until one is set."),
    ga_planned: z
      .boolean()
      .describe(
        "True while the release is not out; false once every step is done."
      ),
    progress: z
      .object({
        done: z.number().int().describe("Steps that are done."),
        total: z
          .number()
          .int()
          .describe("Steps of the release's resolved config."),
      })
      .describe("Steps done out of the release's steps."),
    phase: z
      .string()
      .describe(
        "The phase of the first step that is not done, or Released when every step is done."
      ),
    status: ReleaseStatusSchema,
  })
  .describe("One release in the index.");

const ActiveReleaseSchema = z
  .object({
    version: VersionSchema,
    phase: z.string().describe("The release's current phase."),
    blocking: z.number().int().describe("Steps that are blocking the release."),
    next_milestone: NextMilestoneSchema,
  })
  .describe("A release that is not out yet.");

export const ReleaseIndexSchema = z
  .object({
    active: z
      .array(ActiveReleaseSchema)
      .describe(
        "Releases that are not out yet, newest first. More than one can be in flight, for example a patch release while the next minor release is being prepared."
      ),
    releases: z
      .array(ReleaseIndexEntrySchema)
      .describe("Every release the portal has recorded, newest first."),
    pagination: PaginationSchema.describe(
      "Always null in both directions: the index is not paginated."
    ),
  })
  .describe("The releases the portal tracks.");

const EvidenceSchema = z
  .object({
    text: z.string().describe("One line saying what the check found."),
    url: z
      .string()
      .nullable()
      .describe("A link that shows it; null when there is none."),
  })
  .nullable()
  .describe(
    "What the last check found; null before the step was first checked."
  );

const ManualSchema = z
  .object({
    what_to_check: z.string().describe("What a person has to look at."),
    link: z
      .string()
      .nullable()
      .describe(
        "Where to look; null while it depends on a link that does not exist yet."
      ),
  })
  .nullable()
  .describe(
    "For a step the portal cannot observe: what to check and where. The portal never records a person's answer. Null for a step with an automatic check."
  );

export const ReleaseStepSchema = z
  .object({
    id: z.string().describe("Step id, phase.number, for example 2.3."),
    name: z.string().describe("What the step is."),
    tier: z
      .enum(TIERS)
      .describe(
        "How the work is done today: A automated, S scripted, K skill-assisted, M manual."
      ),
    owner: z.string().describe("The role that owns the step."),
    rc: z
      .string()
      .nullable()
      .describe(
        "The release candidate the state is for, for example rc9, when the step is scoped to one; null otherwise."
      ),
    status: z
      .enum(STEP_STATUSES)
      .describe("The step's state; todo before it was first checked."),
    blocking: z
      .boolean()
      .describe("Whether the step is blocking the go or no-go call."),
    depends_on: z
      .array(z.string())
      .describe("Ids of the steps this one waits for."),
    due: z
      .string()
      .nullable()
      .describe(
        "The planned due date, YYYY-MM-DD; null when it has none or its anchor date is not set."
      ),
    runbook: z
      .record(z.string(), z.string())
      .nullable()
      .describe(
        "How to do the step: a script, a skill or a URL; null when none is given."
      ),
    evidence: EvidenceSchema,
    manual: ManualSchema,
    last_checked: z
      .string()
      .nullable()
      .describe(
        "When the step was last checked, ISO 8601 UTC; null before the first check."
      ),
  })
  .describe("One step of a release.");

const ReleasePhaseSchema = z
  .object({
    id: z.number().int().describe("Phase number."),
    name: z.string().describe("Phase name."),
    collapsed: z
      .boolean()
      .describe(
        "True when every step of the phase is done, so a page can fold it."
      ),
    steps: z.array(ReleaseStepSchema).describe("The phase's steps, in order."),
  })
  .describe("A phase of a release and its steps.");

export const ReleaseBoardSchema = z
  .object({
    version: VersionSchema,
    type: z.enum(RELEASE_TYPES).describe("minor or patch."),
    branch: z.string().describe("The release branch, release/X.Y."),
    current_rc: z
      .string()
      .nullable()
      .describe(
        "The newest release candidate the portal has seen, for example rc9; null before the first."
      ),
    links: z
      .record(z.string(), z.string().nullable())
      .describe(
        "Where to find the release's things: tracker_issue, validation_issue and milestone as found on GitHub; the resources named in the config (wheels, libtorch, docs, release_notes, build_matrix); artifacts, the artifact matrix path of this API's page. A link that does not exist yet is null."
      ),
    stats: z
      .object({
        done: z.number().int().describe("Steps that are done."),
        total: z.number().int().describe("Steps of the release."),
        blocking: z.number().int().describe("Steps that are blocking."),
        next_milestone: NextMilestoneSchema,
        last_checked: z
          .string()
          .nullable()
          .describe(
            "The newest check of any step, ISO 8601 UTC; null before the first."
          ),
      })
      .describe("Counts for the board's header."),
    phases: z
      .array(ReleasePhaseSchema)
      .describe("The release's phases in order."),
  })
  .describe("A release's progress: its phases, steps and the state of each.");

const ConfigStepSchema = z
  .object({
    id: z.string().describe("Step id."),
    phase: z.number().int().describe("Phase number."),
    name: z.string().describe("Step name."),
    tier: z.enum(TIERS).describe("How the work is done today."),
    owner: z.string().describe("Owning role."),
    rc_scoped: z
      .boolean()
      .optional()
      .describe(
        "Whether the step has a separate state for each release candidate."
      ),
    depends_on: z
      .array(z.string())
      .optional()
      .describe("Step ids this step waits for."),
    due: z
      .object({
        anchor: z.string().describe("branch_cut, final_rc or ga."),
        offset_days: z
          .number()
          .int()
          .describe("Days from the anchor's date; negative is before."),
      })
      .optional()
      .describe("When the step is due, relative to a milestone date."),
    runbook: z
      .record(z.string(), z.string())
      .optional()
      .describe("A script, skill or URL."),
    types: z
      .array(z.enum(RELEASE_TYPES))
      .optional()
      .describe("Release types the step applies to; absent means both."),
    window: z
      .object({
        opens: z
          .string()
          .optional()
          .describe(
            "branch_cut: the step is live once the release branch exists."
          ),
        closes: z
          .string()
          .optional()
          .describe("ga: the step is over once the release tag exists."),
      })
      .optional()
      .describe("When the step is live."),
    check: z
      .record(z.string(), z.unknown())
      .describe("How the portal observes the step: a type and its parameters."),
  })
  .describe("A step of the resolved config.");

export const ReleaseConfigSchema = z
  .object({
    version: z.number().int().describe("Config schema version."),
    release: VersionSchema,
    type: z.enum(RELEASE_TYPES).describe("minor or patch."),
    branch: z.string().describe("The release branch."),
    dates: z
      .record(z.string(), z.string().nullable())
      .describe(
        "Planned dates by milestone (branch_cut, final_rc, ga), YYYY-MM-DD or null."
      ),
    links: z
      .record(z.string(), z.union([z.string(), z.number()]).nullable())
      .describe(
        "Links set by hand in the release file; null means found on GitHub."
      ),
    discovery: z
      .record(z.string(), z.unknown())
      .describe(
        "The rules that find the release's milestone, tracker issue and validation issue."
      ),
    resources: z
      .record(z.string(), z.unknown())
      .describe("The link templates shown on the board."),
    phases: z
      .array(
        z.object({
          id: z.number().int().describe("Phase number."),
          name: z.string().describe("Phase name."),
        })
      )
      .describe("The phases."),
    steps: z
      .array(ConfigStepSchema)
      .describe("The steps that apply to this release."),
  })
  .describe(
    "The release's config after merging release/portal/config/steps.yml with the release's own file, as the portal uses it. Steps that do not apply to the release's type are left out."
  );

export const ArtifactRowSchema = z
  .object({
    package: z.string().describe("wheel, libtorch or docker."),
    project: z
      .string()
      .describe("The project, for example torch or torchvision."),
    channel: z
      .string()
      .describe(
        "test for release candidates, release for the final artifacts."
      ),
    accelerator: z.string().describe("cpu, cu130, rocm7.1, xpu, ..."),
    python: z
      .string()
      .describe(
        "The Python tag, for example 3.14 or 3.14t; empty for libtorch and docker."
      ),
    os: z.string().describe("linux, windows or macos."),
    arch: z.string().describe("x86_64, aarch64 or arm64."),
    verdict: z
      .enum(ARTIFACT_VERDICTS)
      .describe(
        "present: found as expected. missing: expected and not found. size_anomalous: found, but its size differs from the same artifact of the previous release by more than the threshold. unexpected: found and not expected."
      ),
    size_bytes: z
      .number()
      .int()
      .nullable()
      .describe("The observed size; null when missing."),
    vs_previous_pct: z
      .number()
      .nullable()
      .describe(
        "Size change against the same artifact in the previous release, in percent; null when there is none."
      ),
    evidence: z
      .object({
        url: z
          .string()
          .nullable()
          .describe(
            "The URL checked: where it was expected, or where it was found."
          ),
        http_status: z
          .number()
          .int()
          .nullable()
          .describe(
            "The status of the check, for example 404 for a missing wheel."
          ),
      })
      .describe("What the collector saw."),
  })
  .describe("One expected release artifact and what the collector found.");

export const ArtifactPageSchema = z
  .object({
    summary: z
      .object({
        expected: z.number().int().describe("Artifacts in the selection."),
        present: z.number().int().describe("Of them, present."),
        missing: z.number().int().describe("Of them, missing."),
        size_anomalous: z.number().int().describe("Of them, size_anomalous."),
        unexpected: z.number().int().describe("Of them, unexpected."),
      })
      .describe(
        "Counts over every artifact that matches channel, os and package, whatever verdict and page; verdict narrows only the rows."
      ),
    rows: z
      .array(ArtifactRowSchema)
      .describe(
        "The page's artifacts, problems first: missing, size_anomalous, unexpected, then present."
      ),
    pagination: PaginationSchema,
  })
  .describe("A release's artifacts: the counts and one page of rows.");

export type ReleaseIndex = z.infer<typeof ReleaseIndexSchema>;
export type ReleaseBoard = z.infer<typeof ReleaseBoardSchema>;
export type ReleaseStep = z.infer<typeof ReleaseStepSchema>;
export type ReleaseConfig = z.infer<typeof ReleaseConfigSchema>;
export type ArtifactRow = z.infer<typeof ArtifactRowSchema>;
export type ArtifactPage = z.infer<typeof ArtifactPageSchema>;
