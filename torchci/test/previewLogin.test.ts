// The preview deployments' password login, which passes the API gate there:
// what it accepts, compared in constant time, and that an unset password is
// no login at all.

const env = process.env as Record<string, string | undefined>;
const saved = {
  VERCEL_ENV: env.VERCEL_ENV,
  PREVIEW_USER: env.PREVIEW_USER,
  PREVIEW_PASS: env.PREVIEW_PASS,
};

function restore() {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
}

// The credentials provider's authorize, from a fresh copy of the module,
// which lists the provider only on a preview deployment. next-auth keeps the
// configured callbacks under `options` until it merges them at request time;
// the top-level `authorize` is its default, which admits nobody.
async function previewAuthorize() {
  let authorize:
    | ((_credentials: Record<string, unknown>) => Promise<unknown>)
    | undefined;
  jest.isolateModules(() => {
    const { authOptions } = require("pages/api/auth/[...nextauth]");
    const provider = authOptions.providers.find(
      (candidate: { type: string }) => candidate.type === "credentials"
    );
    authorize = provider?.options?.authorize;
  });
  return authorize;
}

describe("the preview login", () => {
  afterEach(restore);

  test("exists only on a preview deployment", async () => {
    env.VERCEL_ENV = "production";
    expect(await previewAuthorize()).toBeUndefined();
    env.VERCEL_ENV = "preview";
    expect(await previewAuthorize()).toEqual(expect.any(Function));
  });

  test("admits the configured username and password, marking the user", async () => {
    env.VERCEL_ENV = "preview";
    env.PREVIEW_USER = "reviewer";
    env.PREVIEW_PASS = "correct horse battery staple";
    const authorize = (await previewAuthorize())!;
    const user = (await authorize({
      username: "reviewer",
      password: "correct horse battery staple",
    })) as { id: string; previewAccessToken: string };
    expect(user).toMatchObject({ id: "preview-user" });
    expect(user.previewAccessToken).toEqual(expect.any(String));
  });

  test.each([
    ["a wrong password", { username: "reviewer", password: "wrong" }],
    ["a wrong username", { username: "someone", password: "secret" }],
    ["a password prefix", { username: "reviewer", password: "secre" }],
    ["no password", { username: "reviewer" }],
    ["nothing", {}],
  ])("refuses %s", async (_name, credentials) => {
    env.VERCEL_ENV = "preview";
    env.PREVIEW_USER = "reviewer";
    env.PREVIEW_PASS = "secret";
    const authorize = (await previewAuthorize())!;
    expect(await authorize(credentials)).toBeNull();
  });

  test("is no login at all while the password is unset or empty", async () => {
    env.VERCEL_ENV = "preview";
    env.PREVIEW_USER = "reviewer";
    delete env.PREVIEW_PASS;
    let authorize = (await previewAuthorize())!;
    expect(await authorize({ username: "reviewer" })).toBeNull();
    expect(await authorize({ username: "reviewer", password: "" })).toBeNull();
    expect(await authorize({})).toBeNull();
    env.PREVIEW_PASS = "";
    authorize = (await previewAuthorize())!;
    expect(await authorize({ username: "reviewer", password: "" })).toBeNull();
    delete env.PREVIEW_USER;
    delete env.PREVIEW_PASS;
    authorize = (await previewAuthorize())!;
    expect(await authorize({})).toBeNull();
  });
});
