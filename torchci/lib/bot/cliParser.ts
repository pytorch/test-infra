import { ArgumentParser, RawTextHelpFormatter, SUPPRESS } from "argparse";

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
    "multi-line commands are allowed. " +
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
    "By default, this will wait for all required checks to succeed before merging.",
  formatter_class: RawTextHelpFormatter,
  add_help: false,
});
const mergeOption = merge.add_mutually_exclusive_group();
mergeOption.add_argument("-g", "--green", {
  action: "store_true",
  help: "Merge when *all* status checks pass.",
});
mergeOption.add_argument("-f", "--force", {
  action: "store_true",
  help: "Merge without checking anything. ONLY USE THIS FOR CRITICAL FAILURES.",
});
mergeOption.add_argument("-l", "--land-checks", {
  action: "store_true",
  help: "Merge with land time checks. This will create a new branch that is rebased on viable/strict and run additional tests (EXPERIMENTAL)",
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
  choices: ["nosignal", "ignoredsignal", "landrace", "weird", "ghfirst"],
  help: "A machine-friendly classification of the revert reason.",
});

// Rebase
const rebase = commands.add_parser("rebase", {
  help: "Rebase a PR",
  description:
    "Rebase a PR. Rebasing defaults to the default branch of pytorch (master).\n" +
    "You, along with any member of the pytorch organization, can rebase your PR.",
  formatter_class: RawTextHelpFormatter,
  add_help: false,
});
const branch_selection = rebase.add_mutually_exclusive_group();
branch_selection.add_argument("-s", "--stable", {
  action: "store_true",
  help: "Rebase to viable/strict",
});
branch_selection.add_argument("-b", "--branch", {
  help: "Branch you would like to rebase to",
});

// Help
parser.add_argument("-h", "--help", {
  default: SUPPRESS,
  help: "Show this help message and exit.",
  action: "store_true",
});

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
`;
}
