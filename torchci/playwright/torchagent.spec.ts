import { expect, test } from "@playwright/test";

test.describe("TorchAgent page", () => {
  test("requires authentication when no cookie is present", async ({
    page,
  }) => {
    await page.goto("/torchagent");
    await expect(page.getByText("Authentication Required")).toBeVisible();
  });

  test("shows query input when authenticated via cookie", async ({ page }) => {
    await page.context().addCookies([
      {
        name: "GRAFANA_MCP_AUTH_TOKEN",
        value: "test",
        domain: "localhost",
        path: "/",
        httpOnly: false,
        secure: false,
      },
    ]);
    await page.goto("/torchagent");
    await expect(page.getByTestId("query-input")).toBeVisible();
    await expect(page.getByTestId("run-button")).toBeVisible();
  });
});
