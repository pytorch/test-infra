import { getPrStatusOctokit } from "lib/github";
import { App, Octokit } from "octokit";

jest.mock("octokit", () => ({
  App: jest.fn().mockImplementation(() => ({
    octokit: { request: jest.fn().mockResolvedValue({ data: { id: 42 } }) },
  })),
  Octokit: jest.fn().mockImplementation(() => ({ reader: true })),
}));
const saved = {
  id: process.env.PR_STATUS_APP_ID,
  key: process.env.PR_STATUS_PRIVATE_KEY,
};
beforeEach(() => {
  jest.clearAllMocks();
  process.env.PR_STATUS_APP_ID = "status-reader-app";
  process.env.PR_STATUS_PRIVATE_KEY =
    Buffer.from("dummy-key").toString("base64");
});
afterEach(() => {
  if (saved.id === undefined) delete process.env.PR_STATUS_APP_ID;
  else process.env.PR_STATUS_APP_ID = saved.id;
  if (saved.key === undefined) delete process.env.PR_STATUS_PRIVATE_KEY;
  else process.env.PR_STATUS_PRIVATE_KEY = saved.key;
});
test.each(["PR_STATUS_APP_ID", "PR_STATUS_PRIVATE_KEY"])(
  "missing %s does not silently use the writer app",
  async (key) => {
    delete process.env[key];
    expect(await getPrStatusOctokit("pytorch", "pytorch")).toBeNull();
    expect(App).not.toHaveBeenCalled();
    expect(Octokit).not.toHaveBeenCalled();
  }
);
test("the dedicated reader uses its configured identity and repository installation", async () => {
  expect(await getPrStatusOctokit("pytorch", "pytorch")).toEqual({
    reader: true,
  });
  expect(App).toHaveBeenCalledWith({
    appId: "status-reader-app",
    privateKey: "dummy-key",
  });
  const app = jest.mocked(App).mock.results[0].value;
  expect(app.octokit.request).toHaveBeenCalledWith(
    "GET /repos/{owner}/{repo}/installation",
    { owner: "pytorch", repo: "pytorch" }
  );
  expect(Octokit).toHaveBeenCalledWith(
    expect.objectContaining({
      auth: {
        appId: "status-reader-app",
        privateKey: "dummy-key",
        installationId: 42,
      },
    })
  );
});
