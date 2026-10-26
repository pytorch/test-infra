import {
  HEALTH_STATUSES,
  LANGUAGES,
  RAN_ONS,
  WINDOWS,
} from "lib/api/tests/parameters";
import { z } from "zod/v4";

// What a reader can choose for GET /api/tests: the accepted values of the
// parameters a person picks from, each with a label for running text, and
// what applies when the parameter is absent. The windows, code sources and
// languages are fixed by the code; the environment fields and the test config
// take their values from the catalogs.

const LABEL_DESCRIPTION =
  "How to say the value in running text, after 'within the last', 'on' or 'in': 7 days, pull requests, C++, CUDA, Linux. Lowercase unless a proper name, so it reads mid-sentence; 'none' for an empty value.";

function option<Values extends z.ZodEnum>(
  value: Values,
  valueDescription: string
) {
  return z.object({
    value: value.describe(valueDescription),
    label: z.string().describe(LABEL_DESCRIPTION),
  });
}

// A filter whose values are whatever the catalogs hold: every value seen,
// offered as the exact string GET /api/tests takes for the parameter, and no
// filter at all when the parameter is absent.
function catalogChoice(parameter: string, description: string) {
  return z
    .object({
      default: z
        .array(z.string())
        .describe(
          `What GET /api/tests keeps when ${parameter} is absent: empty, meaning no filter, every value.`
        ),
      values: z
        .array(
          z.object({
            value: z
              .string()
              .describe(
                `A value GET /api/tests accepts for ${parameter}, as the catalog spells it.`
              ),
            label: z.string().describe(LABEL_DESCRIPTION),
          })
        )
        .describe(
          "Every distinct value in the catalog, the empty value included when it occurs, in natural order: versions by number, names alphabetically."
        ),
    })
    .describe(description);
}

export const TestOptionsSchema = z
  .object({
    window: z
      .object({
        default: z
          .enum(WINDOWS)
          .describe("The window GET /api/tests reads when window is absent."),
        values: z
          .array(
            option(
              z.enum(WINDOWS),
              "A value GET /api/tests accepts for window."
            )
          )
          .describe("Every accepted window, shortest first."),
      })
      .describe(
        "The rolling health window: the window parameter of GET /api/tests."
      ),
    ran_on: z
      .object({
        default: z
          .array(z.enum(RAN_ONS))
          .min(1)
          .describe(
            "The code sources GET /api/tests combines when ran_on is absent."
          ),
        values: z
          .array(
            option(z.enum(RAN_ONS), "A value GET /api/tests accepts in ran_on.")
          )
          .describe(
            "Every accepted code source, in menu order. GET /api/tests needs at least one."
          ),
      })
      .describe(
        "The code sources whose health is combined: the ran_on parameter of GET /api/tests."
      ),
    language: z
      .object({
        default: z
          .array(z.enum(LANGUAGES))
          .describe(
            "The languages GET /api/tests keeps when language is absent: empty, meaning no language filter, every language."
          ),
        values: z
          .array(
            option(
              z.enum(LANGUAGES),
              "A value GET /api/tests accepts in language."
            )
          )
          .describe(
            "Every language the tests catalog can record, in menu order."
          ),
      })
      .describe("The test languages: the language filter of GET /api/tests."),
    status: z
      .object({
        default: z
          .array(z.enum(HEALTH_STATUSES))
          .describe(
            "The statuses GET /api/tests keeps when status is absent: empty, meaning no status filter, every status."
          ),
        values: z
          .array(
            option(
              z.enum(HEALTH_STATUSES),
              "A value GET /api/tests accepts in status."
            )
          )
          .describe("Every health status, worst first."),
      })
      .describe(
        "The health statuses of a configuration's runs: the status filter of GET /api/tests."
      ),
    os: catalogChoice(
      "os",
      "The operating systems in the environments catalog: the os filter of GET /api/tests."
    ),
    os_version: catalogChoice(
      "os_version",
      "The OS and container image versions in the environments catalog: the os_version filter of GET /api/tests."
    ),
    cpu_architecture: catalogChoice(
      "cpu_architecture",
      "The CPU architectures in the environments catalog: the cpu_architecture filter of GET /api/tests."
    ),
    cpu_capability: catalogChoice(
      "cpu_capability",
      "The CPU kernel capabilities in the environments catalog: the cpu_capability filter of GET /api/tests."
    ),
    python_version: catalogChoice(
      "python_version",
      "The Python versions in the environments catalog: the python_version filter of GET /api/tests."
    ),
    cc_compiler: catalogChoice(
      "cc_compiler",
      "The compilers that built torch in the environments catalog: the cc_compiler filter of GET /api/tests."
    ),
    cc_compiler_version: catalogChoice(
      "cc_compiler_version",
      "The compiler versions in the environments catalog: the cc_compiler_version filter of GET /api/tests."
    ),
    accelerator: catalogChoice(
      "accelerator",
      "The accelerators torch was built for in the environments catalog: the accelerator filter of GET /api/tests."
    ),
    accelerator_version: catalogChoice(
      "accelerator_version",
      "The accelerator stack versions in the environments catalog, empty for cpu and mps: the accelerator_version filter of GET /api/tests."
    ),
    device_name: catalogChoice(
      "device_name",
      "The device names in the environments catalog, as their vendors report them, empty without a device: the device_name filter of GET /api/tests."
    ),
    device_count: catalogChoice(
      "device_count",
      "The numbers of visible devices in the environments catalog, as decimal strings: the device_count filter of GET /api/tests."
    ),
    test_config: catalogChoice(
      "test_config",
      "The TEST_CONFIG values in the env vars catalog: the test_config filter of GET /api/tests."
    ),
    workflow_path: catalogChoice(
      "workflow_path",
      "The calling workflow paths the health table has seen in its longest window on either code source, labelled by the workflow file (.github/workflows/pull.yml is pull.yml): the workflow_path filter of GET /api/tests."
    ),
    owner: catalogChoice(
      "owner",
      "The owner labels in the owners catalog, without the module: prefix, such as nn or core_tests: the owner filter of GET /api/tests."
    ),
  })
  .describe(
    "The values GET /api/tests accepts for the parameters a reader chooses from, each with a label for running text, and the value that applies when the parameter is absent. The windows, code sources, languages and health statuses are read from the list's own parameter definitions, so a value the list accepts is here and no other, and change only with the code. The environment fields and the test config are read from the catalogs when asked, the workflow paths from the health table and the owner labels from the owners catalog, so they change as new environments, env var sets, workflows and owners are recorded."
  );

export type TestOptions = z.infer<typeof TestOptionsSchema>;
