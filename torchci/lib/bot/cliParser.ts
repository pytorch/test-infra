import minimist from "minimist";

const cliOptions: { [key: string]: any } = {
  revert: {
    options: [
      {
        key: "message",
        alternatives: ["m", "message"],
        type: "string",
      },
      {
        key: "classification",
        alternatives: ["c", "classification"],
        type: "string",
      },
    ],
  },
  help: {
    options: [],
  },
  merge: {
    options: [
      {
        key: "green",
        alternatives: ["g", "green", "onGreen"],
        type: "flag",
      },
      {
        key: "allGreen",
        alternatives: ["ag", "allGreen", "onAllGreen"],
        type: "flag",
      },
      {
        key: "force",
        alternatives: ["f", "force"],
        type: "flag",
      },
    ],
  },
  rebase: {
    options: [],
  },
};

export function parseComment(commentBody: string) {
  const parsedBody = commentBody.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const commentOptions = minimist(parsedBody);
  return commentOptions;
}

export function getCommand(opts: any): string | null {
  if (
    !("_" in opts) ||
    opts["_"].length < 2 ||
    opts["_"][0] !== "@pytorchbot"
  ) {
    return null;
  }
  const cmd = opts["_"][1];
  return cmd in cliOptions ? cmd : null;
}

export function getOptions(command: string | null, opts: any): any {
  if (command === null || !(command in cliOptions)) {
    return null;
  }
  const options = cliOptions[command]["options"];
  const out: any = {};
  for (const option of options) {
    if (option["type"] === "flag") {
      const flag = getFlag(opts, option["alternatives"]);
      out[option["key"]] = flag;
    } else if (option["type"] === "string") {
      const str = getString(opts, option["alternatives"]);
      out[option["key"]] = str;
    }
  }
  return out;
}

function getFlag(opts: any, alternatives: string): boolean {
  for (const alternative of alternatives) {
    if (alternative in opts) {
      return true;
    }
  }
  return false;
}

function getString(opts: any, alternatives: string): string | null {
  for (const alternative of alternatives) {
    if (alternative in opts) {
      return opts[alternative];
    }
  }
  return null;
}
