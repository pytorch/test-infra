export const GREENLIGHT_MENTION = "@greenlight";

// The mention has to open the line so that quoting an earlier comment does not
// re-run the command it contained. Four or more leading spaces is an indented
// markdown code block, which renders the line as sample text rather than as a
// command addressed to the bot. Matched case-insensitively because GitHub
// resolves mentions that way and greenlight's own is_bot_command
// (greenlight/src/greenlight/pr_hash.py) lowercases the body before looking for
// the trigger: a differently-cased mention the bot ignored would still be
// dropped from the fingerprint, so the comment would count for nothing at all.
const botCommandPattern = new RegExp(
  `^ {0,3}${GREENLIGHT_MENTION} (.+)$`,
  "im"
);

// A fence, an HTML comment and a <pre> block all render their contents as
// sample text rather than as a live mention, so a trigger inside one is never
// a command addressed to the bot. Each closing delimiter is optional because
// CommonMark does not require one: an unclosed opener runs to the end of the
// comment, and an unterminated HTML comment renders nothing visible at all.
const quotedRegionPatterns = [
  /```[\s\S]*?(?:```|$)/g,
  /~~~[\s\S]*?(?:~~~|$)/g,
  /<!--[\s\S]*?(?:-->|$)/g,
  /<pre[\s>][\s\S]*?(?:<\/pre>|$)/gi,
];

// The command vocabulary. It generates the help text and decides which names
// are valid; the handler keys its dispatch table off this type, so a command
// added here has to be given behaviour there before the bot compiles.
export const GREENLIGHT_COMMANDS = {
  recheck: "Ask Green Light to look at this pull request again.",
  help: "Show this message.",
} as const;

export type GreenlightCommandName = keyof typeof GREENLIGHT_COMMANDS;

export function getInputArgs(commentBody: string): string {
  const addressed = quotedRegionPatterns.reduce(
    (body, pattern) => body.replace(pattern, ""),
    commentBody
  );
  return addressed.match(botCommandPattern)?.[1].trim() ?? "";
}

export function parseCommandName(inputArgs: string): string {
  // GitHub comments are prose, so the command is matched the way a reader would
  // read it rather than the way a shell would.
  return (inputArgs.split(/\s+/)[0] ?? "").toLowerCase();
}

export function isGreenlightCommand(
  name: string
): name is GreenlightCommandName {
  return Object.prototype.hasOwnProperty.call(GREENLIGHT_COMMANDS, name);
}

export function getHelp(): string {
  const rows = Object.entries(GREENLIGHT_COMMANDS).map(
    ([name, description]) => `| \`${name}\` | ${description} |`
  );
  return [
    "# Green Light Bot",
    "",
    `Comment a line that starts with \`${GREENLIGHT_MENTION} <command>\` on a pull request.`,
    "",
    "| command | description |",
    "| --- | --- |",
    ...rows,
  ].join("\n");
}
