import { ArgumentParser, RawTextHelpFormatter, SUPPRESS } from "argparse";
import { cherryPickClassifications, revertClassifications } from "./Constants";

// The default ArgumentParser is designed to be used from the command line, so
// when it encounters an error it calls process.exit. We want to throw an
// exception that we can catch and present to the user instead.
class NonExitingArgumentParser extends ArgumentParser {
  error(message: string) {
    // @ts-expect-error
    throw Error(`${this.prog}: error: ${message}\n\n${this.format_usage()}`);
  }
}

// NOTE: When adding a new command, make sure to add it to the getHelp function!
const parser = new NonExitingArgumentParser({
  prog: "@pytorchbot",
  description:
    "In order to invoke the bot on your PR, include a line that starts with\n" +
    "@pytorchbot anywhere in a comment. That line will form the command; no\n" +
    "multi-line commands are allowed. Some commands may be used on issues as specified below." +
    `

Example:
    Some extra context, blah blah, wow this PR looks awesome

    @pytorchbot merge
`,
  formatter_class: RawTextHelpFormatter,
  add_help: false,
});
const commands = parser.add_subparsers({ title: "command", dest: "command" });

// Merge
const merge = commands.add_parser("merge", {
  help: "Merge a PR",
  description:
    "Merge an accepted PR, subject to the rules in .github/merge_rules.json.\n" +
    "By default, this will wait for all required checks (lint, pull) to succeed before merging.",
  formatter_class: RawTextHelpFormatter,
  add_help: false,
});
const mergeOption = merge.add_mutually_exclusive_group();
mergeOption.add_argument("-f", "--force", {
  metavar: "MESSAGE",
  help:
    `Merge without checking anything. This requires a reason for auditting purpose, for example:
@pytorchbot merge -f 'Minor update to fix lint. Expecting all PR tests to pass'` +
    "\n\n" +
    "Please use `-f` as last resort, prefer `--ignore-current` to continue the merge ignoring current failures. " +
    "This will allow currently pending tests to finish and report signal before the merge.",
});
mergeOption.add_argument("-i", "--ignore-current", {
  action: "store_true",
  help: "Merge while ignoring the currently failing jobs.  Behaves like -f if there are no pending jobs.",
});
merge.add_argument("-ic", {
  action: "store_true",
  help: "Old flag for --ignore-current. Deprecated in favor of -i.",
});
merge.add_argument("-r", "--rebase", {
  help:
    "Rebase the PR to re run checks before merging.  Accepts viable/strict or main as branch options and " +
    "will default to viable/strict if not specified.",
  nargs: "?",
  const: "viable/strict",
  choices: ["viable/strict", "main"],
});
merge.add_argument("-h", "--help", {
  action: "store_true",
  help: SUPPRESS,
});

// Revert
const revert = commands.add_parser("revert", {
  help: "Revert a PR",
  description: `Revert a merged PR. This requires that you are a Meta employee.

Example:
  @pytorchbot revert -m="This is breaking tests on trunk. hud.pytorch.org/" -c=nosignal
`,
  formatter_class: RawTextHelpFormatter,
  add_help: false,
});
revert.add_argument("-m", "--message", {
  required: true,
  help: "The reason you are reverting, will be put in the commit message. Must be longer than 3 words.",
});
revert.add_argument("-c", "--classification", {
  required: true,
  choices: Object.keys(revertClassifications),
  help: "A machine-friendly classification of the revert reason.",
});
revert.add_argument("-h", "--help", {
  action: "store_true",
  help: SUPPRESS,
});

// Rebase
const rebase = commands.add_parser("rebase", {
  help: "Rebase a PR",
  description:
    "Rebase a PR. Rebasing defaults to the stable viable/strict branch of pytorch.\n" +
    "Repeat contributor may use this command to rebase their PR.",
  formatter_class: RawTextHelpFormatter,
  add_help: false,
});
const branch_selection = rebase.add_mutually_exclusive_group();
branch_selection.add_argument("-s", "--stable", {
  action: "store_true",
  help: "[DEPRECATED] Rebase onto viable/strict",
});
branch_selection.add_argument("-b", "--branch", {
  help: "Branch you would like to rebase to",
});
rebase.add_argument("-h", "--help", {
  action: "store_true",
  help: SUPPRESS,
});

const label = commands.add_parser("label", {
  help: "Add label to a PR",
  description: "Adds label to a PR or Issue [Can be used on Issues]",
  formatter_class: RawTextHelpFormatter,
  add_help: false,
});
label.add_argument("labels", {
  type: "string",
  nargs: "+",
  help: "Labels to add to given Pull Request or Issue [Can be used on Issues]",
});
label.add_argument("-h", "--help", {
  action: "store_true",
  help: SUPPRESS,
});

// Dr. CI
const drCi = commands.add_parser("drci", {
  help: "Update Dr. CI",
  description:
    "Update Dr. CI. Updates the Dr. CI comment on the PR in case it's gotten out of sync " +
    "with actual CI results.",
  formatter_class: RawTextHelpFormatter,
  add_help: false,
});
drCi.add_argument("-h", "--help", {
  action: "store_true",
  help: SUPPRESS,
});

// cherry-pick
const cherryPick = commands.add_parser("cherry-pick", {
  help: "Cherry pick a PR onto a release branch",
  description:
    "Cherry pick a pull request onto a release branch for inclusion in a release\n",
  formatter_class: RawTextHelpFormatter,
  add_help: false,
});
cherryPick.add_argument("--onto", "--into", {
  required: true,
  help: "Branch you would like to cherry pick onto (Example: release/2.1)",
});
cherryPick.add_argument("--fixes", {
  help: "Link to the issue that your PR fixes (Example: https://github.com/pytorch/pytorch/issues/110666)",
});
cherryPick.add_argument("-c", "--classification", {
  required: true,
  choices: Object.keys(cherryPickClassifications),
  help: "A machine-friendly classification of the cherry-pick reason.",
});
cherryPick.add_argument("-h", "--help", {
  action: "store_true",
  help: SUPPRESS,
});

// Help
parser.add_argument("-h", "--help", {
  default: SUPPRESS,
  help: "Show this help message and exit.",
  action: "store_true",
});

const botCommandPattern = new RegExp(/^ *@pytorch(merge|)bot .+$/m);

export function getInputArgs(commentBody: string): string {
  const match = commentBody.match(botCommandPattern);
  if (!match) {
    return "";
  }

  return match[0].replace(/@pytorch(merge|)bot/, "");
}

export function getParser() {
  return parser;
}

export function getHelp(): string {
  return `
# PyTorchBot Help
\`\`\`
${parser.format_help()}\`\`\`
## Merge
\`\`\`
${merge.format_help()}\`\`\`
## Revert
\`\`\`
${revert.format_help()}\`\`\`
## Rebase
\`\`\`
${rebase.format_help()}\`\`\`
## Label
\`\`\`
${label.format_help()}\`\`\`
## Dr CI
\`\`\`
${drCi.format_help()}\`\`\`
## cherry-pick
\`\`\`
${cherryPick.format_help()}\`\`\`
`;
}
