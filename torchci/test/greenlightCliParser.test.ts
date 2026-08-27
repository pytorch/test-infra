import {
  getHelp,
  getInputArgs,
  GREENLIGHT_COMMANDS,
  GREENLIGHT_MENTION,
  isGreenlightCommand,
  parseCommandName,
} from "lib/bot/greenlightCliParser";

describe("getInputArgs", () => {
  test("takes the command off a line that opens with the mention", () => {
    expect(getInputArgs("@greenlight recheck")).toBe("recheck");
    expect(getInputArgs("please have a look\n@greenlight recheck")).toBe(
      "recheck"
    );
    expect(getInputArgs("  @greenlight recheck  ")).toBe("recheck");
  });

  test("keeps the rest of the line", () => {
    expect(getInputArgs("@greenlight recheck now please")).toBe(
      "recheck now please"
    );
  });

  test("ignores a mention that does not open its line", () => {
    expect(getInputArgs("cc @greenlight recheck")).toBe("");
    expect(getInputArgs("> @greenlight recheck")).toBe("");
    expect(getInputArgs("`@greenlight recheck`")).toBe("");
  });

  test("ignores a mention with nothing after it", () => {
    expect(getInputArgs("@greenlight")).toBe("");
    expect(getInputArgs("@greenlight ")).toBe("");
  });

  test("reads a mention whatever case it was typed in", () => {
    expect(getInputArgs("@GreenLight recheck")).toBe("recheck");
    expect(getInputArgs("@GREENLIGHT Recheck")).toBe("Recheck");
  });

  test("ignores a mention inside a fenced code block", () => {
    expect(getInputArgs("```\n@greenlight recheck\n```")).toBe("");
    expect(getInputArgs("~~~\n@greenlight recheck\n~~~")).toBe("");
    expect(getInputArgs("```suggestion\n@greenlight recheck\n```")).toBe("");
  });

  test("ignores a mention inside an HTML comment", () => {
    expect(getInputArgs("<!-- @greenlight recheck -->")).toBe("");
    expect(getInputArgs("<!--\n@greenlight recheck\n-->")).toBe("");
  });

  test("ignores a mention inside a pre block", () => {
    expect(getInputArgs("<pre>\n@greenlight recheck\n</pre>")).toBe("");
    expect(getInputArgs('<pre class="x">\n@greenlight recheck\n</pre>')).toBe(
      ""
    );
  });

  test("ignores a mention inside a region nobody closed", () => {
    expect(getInputArgs("```\n@greenlight recheck")).toBe("");
    expect(getInputArgs("~~~\n@greenlight recheck")).toBe("");
    expect(getInputArgs("```python\n@greenlight recheck")).toBe("");
    expect(getInputArgs("<!--\n@greenlight recheck")).toBe("");
    expect(getInputArgs("<pre>\n@greenlight recheck")).toBe("");
  });

  test("keeps reading a mention after a tag that only looks like pre", () => {
    expect(getInputArgs("<pretend>\n@greenlight recheck")).toBe("recheck");
  });

  test("ignores a mention indented into a code block", () => {
    expect(getInputArgs("    @greenlight recheck")).toBe("");
    expect(getInputArgs("   @greenlight recheck")).toBe("recheck");
  });

  test("still finds a command outside the block it skipped", () => {
    expect(
      getInputArgs("```\n@greenlight help\n```\n@greenlight recheck")
    ).toBe("recheck");
  });

  test("ignores a comment with no mention at all", () => {
    expect(getInputArgs("")).toBe("");
    expect(getInputArgs("looks good to me")).toBe("");
    expect(getInputArgs("@greenlighter recheck")).toBe("");
  });
});

describe("parseCommandName", () => {
  test("takes the first word", () => {
    expect(parseCommandName("recheck now")).toBe("recheck");
    expect(parseCommandName("recheck")).toBe("recheck");
  });

  test("folds case, because a comment is prose", () => {
    expect(parseCommandName("RECHECK")).toBe("recheck");
    expect(parseCommandName("Recheck please")).toBe("recheck");
  });

  test("gives an empty name for an empty argument string", () => {
    expect(parseCommandName("")).toBe("");
  });
});

describe("isGreenlightCommand", () => {
  test("accepts every command the vocabulary declares", () => {
    for (const name of Object.keys(GREENLIGHT_COMMANDS)) {
      expect(isGreenlightCommand(name)).toBe(true);
    }
  });

  test("rejects anything else, including inherited properties", () => {
    expect(isGreenlightCommand("relabel")).toBe(false);
    expect(isGreenlightCommand("")).toBe(false);
    expect(isGreenlightCommand("toString")).toBe(false);
    expect(isGreenlightCommand("constructor")).toBe(false);
  });
});

describe("getHelp", () => {
  test("lists every command in the vocabulary", () => {
    const help = getHelp();
    for (const [name, description] of Object.entries(GREENLIGHT_COMMANDS)) {
      expect(help).toContain(`| \`${name}\` | ${description} |`);
    }
  });

  test("shows the trigger the parser actually matches", () => {
    expect(getHelp()).toContain(`\`${GREENLIGHT_MENTION} <command>\``);
    expect(getInputArgs(`${GREENLIGHT_MENTION} help`)).toBe("help");
  });
});
