import {
  getLambdaClient,
  invokeLogUploader,
  MissingAwsCredentialsError,
} from "lib/lambda";

describe("getLambdaClient", () => {
  const saved = {
    id: process.env.OUR_AWS_ACCESS_KEY_ID,
    secret: process.env.OUR_AWS_SECRET_ACCESS_KEY,
  };

  afterEach(() => {
    process.env.OUR_AWS_ACCESS_KEY_ID = saved.id;
    process.env.OUR_AWS_SECRET_ACCESS_KEY = saved.secret;
  });

  function setCredentials(id?: string, secret?: string) {
    if (id === undefined) {
      delete process.env.OUR_AWS_ACCESS_KEY_ID;
    } else {
      process.env.OUR_AWS_ACCESS_KEY_ID = id;
    }
    if (secret === undefined) {
      delete process.env.OUR_AWS_SECRET_ACCESS_KEY;
    } else {
      process.env.OUR_AWS_SECRET_ACCESS_KEY = secret;
    }
  }

  test.each([
    ["neither is set", undefined, undefined],
    ["only the key id is set", "AKIA", undefined],
    ["only the secret is set", undefined, "shh"],
    ["the key id is empty", "", "shh"],
  ])("throws a named error when %s", (_label, id, secret) => {
    setCredentials(id, secret);
    expect(() => getLambdaClient()).toThrow(MissingAwsCredentialsError);
  });

  test("the error names the variables to set", () => {
    setCredentials(undefined, undefined);
    // The SDK's own message is "Resolved credential object is not valid", which
    // gives whoever is paged nothing to act on.
    expect(() => getLambdaClient()).toThrow(/OUR_AWS_ACCESS_KEY_ID/);
  });

  test("builds a client when both are set", () => {
    setCredentials("AKIA", "shh");
    expect(getLambdaClient()).toBeDefined();
  });

  test("bounds retries and socket waits", async () => {
    setCredentials("AKIA", "shh");
    const config = getLambdaClient().config;
    expect(await config.maxAttempts()).toBe(2);
  });

  test("invokeLogUploader rejects rather than hanging with no credentials", async () => {
    setCredentials(undefined, undefined);
    await expect(
      invokeLogUploader({ repo: "pytorch/pytorch", job_id: 1 })
    ).rejects.toThrow(MissingAwsCredentialsError);
  });
});
