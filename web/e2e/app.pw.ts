import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { startTestServer, cleanupTestServer, type TestContext } from "./helpers.js";

let ctx: TestContext;

test.afterEach(async () => {
  if (ctx) await cleanupTestServer(ctx);
});

test("setup screen is shown when no folder configured", async ({ page }) => {
  ctx = await startTestServer(false);
  await page.goto(ctx.server.url);
  await expect(page.locator('[data-testid="setup-screen"]')).toBeVisible();
});

test("dashboard shows files after sync", async ({ page }) => {
  ctx = await startTestServer(true);
  await writeFile(join(ctx.folder, "hello.txt"), "hello world");

  await page.goto(ctx.server.url);

  // Wait for the file to appear in the table
  await expect(page.locator('[data-testid="file-row"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("text=/hello.txt/")).toBeVisible();
});

test("activity tab receives real-time events", async ({ page }) => {
  ctx = await startTestServer(true);
  await page.goto(ctx.server.url);

  // Click the Activity tab
  await page.getByRole("button", { name: "Activity" }).click();

  // Write a file to trigger an event
  await writeFile(join(ctx.folder, "event-test.txt"), "event data");

  // Wait for an event to appear
  await expect(page.locator('[data-testid="event-row"]')).toBeVisible({ timeout: 15_000 });
});

test("theme toggle switches between dark and light", async ({ page }) => {
  ctx = await startTestServer(true);
  await page.goto(ctx.server.url);

  // Default should be dark
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // Click theme toggle (sun icon)
  await page.getByTitle("Toggle theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  // Persist across reload
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("POST /api/shutdown stops the server", async ({ request }) => {
  ctx = await startTestServer(true);

  const res = await request.post(`${ctx.server.url}/api/shutdown`);
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.ok).toBe(true);

  // Server should be down — subsequent request should fail
  await expect(async () => {
    await request.get(`${ctx.server.url}/api/status`);
  }).rejects.toThrow();
});
