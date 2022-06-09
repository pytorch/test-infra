import { ArgumentParser } from "argparse";

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
  add_help: false,
});
const commands = parser.add_subparsers({ title: "command", dest: "command" });

// Merge
const merge = commands.add_parser("merge", {
  help: "Merge a PR",
  add_help: false,
});
merge.add_argument("-g", "--green", {
  action: "store_true",
  help: "Merge when all status checks pass.",
});
merge.add_argument("-f", "--force", {
  action: "store_true",
  help: "Merge without checking anything. ONLY USE THIS FOR CRITICAL FAILURES.",
});

// Revert
const revert = commands.add_parser("revert", {
  help: "Revert a merged PR",
  add_help: false,
});
revert.add_argument("-m", "--message", {
  required: true,
  help: "The reason you are reverting, will be put in the commit message.",
});
revert.add_argument("-c", "--classification", {
  choices: ["nosignal", "ignoredsignal", "landrace", "weird", "ghfirst"],
  help: "A machine-friendly classification of the revert reason.",
});

// Rebase
const rebase = commands.add_parser("rebase", {
  help: "Rebase a PR",
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
commands.add_parser("help", {
  help: "Show help",
  add_help: false,
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
---
For more info, consult the [wiki](https://github.com/pytorch/pytorch/wiki/Bot-commands).
`;
}
