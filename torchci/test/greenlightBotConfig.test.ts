import { generateKeyPairSync } from "crypto";
import { greenlightPrivateKey } from "lib/bot/greenlightAppAuth";
import {
  assertGreenlightBotConfig,
  greenlightRepos,
} from "lib/bot/greenlightBotConfig";

const ENV_VARS = [
  "GREENLIGHT_APP_ID",
  "GREENLIGHT_APP_PRIVATE_KEY",
  "GREENLIGHT_WEBHOOK_SECRET",
  "GREENLIGHT_BOT_REPOS",
];

let pkcs1: string;
let pkcs8: string;

function setEnv(values: Record<string, string | undefined>) {
  for (const name of ENV_VARS) {
    const value = values[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

function completeEnv(
  overrides: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  return {
    GREENLIGHT_APP_ID: "4441283",
    GREENLIGHT_APP_PRIVATE_KEY: pkcs1,
    GREENLIGHT_WEBHOOK_SECRET: "s3cret",
    GREENLIGHT_BOT_REPOS: "pytorch/pytorch",
    ...overrides,
  };
}

describe("greenlight bot configuration", () => {
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    pkcs1 = pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    pkcs8 = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    for (const name of ENV_VARS) {
      saved[name] = process.env[name];
    }
  });

  afterAll(() => {
    setEnv(saved);
  });

  describe("greenlightRepos", () => {
    test("parses the allowlist out of the environment", () => {
      setEnv(
        completeEnv({ GREENLIGHT_BOT_REPOS: "pytorch/pytorch, PyTorch/*" })
      );
      expect(greenlightRepos()).toEqual(
        new Set(["pytorch/pytorch", "pytorch/*"])
      );
    });

    test("enables nothing when it is unset", () => {
      setEnv(completeEnv({ GREENLIGHT_BOT_REPOS: undefined }));
      expect(greenlightRepos()).toEqual(new Set());
    });

    test("picks up a change without a restart", () => {
      setEnv(completeEnv({ GREENLIGHT_BOT_REPOS: "pytorch/pytorch" }));
      expect(greenlightRepos()).toEqual(new Set(["pytorch/pytorch"]));
      setEnv(completeEnv({ GREENLIGHT_BOT_REPOS: "pytorch/executorch" }));
      expect(greenlightRepos()).toEqual(new Set(["pytorch/executorch"]));
    });
  });

  describe("assertGreenlightBotConfig", () => {
    test("passes on a complete environment", () => {
      setEnv(completeEnv());
      expect(() => assertGreenlightBotConfig()).not.toThrow();
    });

    test.each(ENV_VARS)("names %s when it is missing", (name) => {
      setEnv(completeEnv({ [name]: undefined }));
      expect(() => assertGreenlightBotConfig()).toThrow(name);
    });

    test("names every missing variable at once", () => {
      setEnv({});
      expect(() => assertGreenlightBotConfig()).toThrow(ENV_VARS.join(", "));
    });

    test("rejects a key probot cannot read", () => {
      setEnv(completeEnv({ GREENLIGHT_APP_PRIVATE_KEY: pkcs8 }));
      expect(() => assertGreenlightBotConfig()).toThrow("PKCS#1");
    });
  });

  describe("greenlightPrivateKey", () => {
    test("takes a PKCS#1 PEM as it is", () => {
      setEnv(completeEnv({ GREENLIGHT_APP_PRIVATE_KEY: pkcs1 }));
      expect(greenlightPrivateKey()).toBe(pkcs1);
    });

    test("decodes a base64-encoded PKCS#1 PEM", () => {
      setEnv(
        completeEnv({
          GREENLIGHT_APP_PRIVATE_KEY: Buffer.from(pkcs1).toString("base64"),
        })
      );
      expect(greenlightPrivateKey()).toBe(pkcs1);
    });

    test("rejects a PKCS#8 PEM, which the Actions secret may hold", () => {
      setEnv(completeEnv({ GREENLIGHT_APP_PRIVATE_KEY: pkcs8 }));
      expect(() => greenlightPrivateKey()).toThrow("openssl rsa");
    });

    test("rejects a base64-encoded PKCS#8 PEM", () => {
      setEnv(
        completeEnv({
          GREENLIGHT_APP_PRIVATE_KEY: Buffer.from(pkcs8).toString("base64"),
        })
      );
      expect(() => greenlightPrivateKey()).toThrow("PKCS#1");
    });

    test("rejects a PEM whose newlines were lost in transit", () => {
      setEnv(
        completeEnv({
          GREENLIGHT_APP_PRIVATE_KEY: pkcs1.replace(/\n/g, ""),
        })
      );
      expect(() => greenlightPrivateKey()).toThrow("real newlines");
    });

    test("rejects an unset key", () => {
      setEnv(completeEnv({ GREENLIGHT_APP_PRIVATE_KEY: undefined }));
      expect(() => greenlightPrivateKey()).toThrow(
        "GREENLIGHT_APP_PRIVATE_KEY"
      );
    });
  });
});
