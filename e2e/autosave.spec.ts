import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { resetData, sql } from "./support";

test.beforeEach(resetData);

async function holdSave(page: Page) {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<"continue" | "abort">();
  let held = false;
  await page.route("**/profile**", async (route) => {
    if (held || route.request().method() !== "POST") return route.continue();
    held = true;
    started.resolve();
    const result = await release.promise;
    if (result === "abort") await route.abort().catch(() => {});
    else await route.continue();
  });
  return { started: started.promise, release: () => release.resolve("continue"), abort: () => release.resolve("abort") };
}

async function expectStoredName(name: string) {
  expect(await sql('SELECT value AS name FROM "ProfileField" WHERE key = $1', ['name'])).toEqual([{ name }]);
}

test("waits for the newest edit before following a link", async ({ page }) => {
  await page.goto("/profile");
  const held = await holdSave(page);
  await page.getByLabel("Full name").fill("Morgan First");
  await held.started;
  await page.getByLabel("Full name").fill("Morgan Latest");
  await expect(page.getByText("Saving…")).toBeVisible();
  await page.getByRole("link", { name: "See base resume →" }).click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByText("Saved just now")).toHaveCount(0);
  held.release();
  await expect(page).toHaveURL(/\/resume$/);
  await expectStoredName("Morgan Latest");
  await expect(page.getByRole("article", { name: "Resume" })).toContainText("Morgan Latest");
});

test("recovers an interrupted save after an explicitly confirmed reload", async ({ page }) => {
  await page.goto("/profile");
  const held = await holdSave(page);
  await page.getByLabel("Full name").fill("Morgan Recovered");
  await held.started;
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => { dialogs.push(dialog.type()); await dialog.accept(); });
  await page.reload();
  held.abort();
  await expect(page.getByLabel("Full name")).toHaveValue("Morgan Recovered");
  await expect(page.getByText("Saved just now")).toBeVisible();
  expect(dialogs).toContain("beforeunload");
  await expectStoredName("Morgan Recovered");
  expect(await page.evaluate(() => sessionStorage.getItem("dossier:autosave:v1:profile:basics"))).toBeNull();
});

test("waits for pending edits before browser Back and preserves them on Forward", async ({ page }) => {
  await page.goto("/profile?section=skills");
  await page.getByRole("navigation", { name: "Profile sections" }).getByRole("link", { name: /Basics/ }).click();
  const held = await holdSave(page);
  await page.getByLabel("Full name").fill("Morgan History");
  await held.started;
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(/section=basics/);
  held.release();
  await expect(page).toHaveURL(/section=skills/);
  await expectStoredName("Morgan History");
  await page.evaluate(() => history.forward());
  await expect(page.getByLabel("Full name")).toHaveValue("Morgan History");
});

test("does not navigate or report Saved after rejected writes; retry preserves the edit", async ({ page }) => {
  await page.goto("/profile");
  await page.route("**/profile**", (route) => route.request().method() === "POST" ? route.abort("failed") : route.continue());
  await page.getByLabel("Full name").fill("Morgan Retry");
  await expect(page.getByText("Couldn't save", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "See base resume →" }).click();
  await expect(page.getByText("Couldn't save", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByLabel("Full name")).toHaveValue("Morgan Retry");
  await page.unroute("**/profile**");
  await page.getByRole("link", { name: "See base resume →" }).click();
  await expect(page).toHaveURL(/\/resume$/);
  await expectStoredName("Morgan Retry");
});

test("recovers a publication even when its card is collapsed after reload", async ({ page }) => {
  await page.goto("/profile?section=publications");
  await page.getByRole("button", { name: /Trust in automated scheduling/, expanded: false }).click();
  const held = await holdSave(page);
  await page.getByRole("textbox", { name: "Citation" }).fill("Morgan. A recovered publication.");
  await held.started;
  page.on("dialog", (dialog) => dialog.accept());
  await page.reload();
  held.abort();
  await expect(page.getByText("Saved just now")).toBeVisible();
  expect(await sql('SELECT citation FROM "Publication" WHERE citation = $1', ["Morgan. A recovered publication."])).toHaveLength(1);
  await expect(page.getByRole("button", { name: /Morgan\. A recovered publication\./, expanded: false })).toBeVisible();
});

for (const keepDraft of [true, false]) {
  test(`reviews a conflicting recovery before keeping the ${keepDraft ? "draft" : "server"} version`, async ({ page }, testInfo) => {
    await page.goto("/profile");
    const held = await holdSave(page);
    await page.getByLabel("Full name").fill("Morgan Draft");
    await held.started;
    await sql('UPDATE "ProfileField" SET value = $1 WHERE key = $2', ["Morgan Server", "name"]);
    page.on("dialog", (dialog) => dialog.accept());
    await page.reload();
    held.abort();
    const review = page.getByRole("alertdialog");
    await expect(review).toContainText("Morgan Draft");
    await expect(review).toContainText("Morgan Server");
    await expectStoredName("Morgan Server");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("recovery-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await expect(review).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("recovery-mobile.png") });
    await page.getByRole("button", { name: keepDraft ? "Use recovered changes" : "Keep saved version" }).focus();
    await page.keyboard.press("Enter");
    await expect(review).toHaveCount(0);
    if (keepDraft) await expect(page.getByText("Saved just now")).toBeVisible();
    await expectStoredName(keepDraft ? "Morgan Draft" : "Morgan Server");
    expect(await page.evaluate(() => sessionStorage.getItem("dossier:autosave:v1:profile:basics"))).toBeNull();
  });
}

test("offers recovery for edits in a different section instead of claiming everything is saved", async ({ page }) => {
  await page.goto("/profile");
  const held = await holdSave(page);
  await page.getByLabel("Full name").fill("Morgan Elsewhere");
  await held.started;
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/profile?section=skills");
  held.abort();
  await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Review Profile basics" }).click();
  await expect(page.getByLabel("Full name")).toHaveValue("Morgan Elsewhere");
  await expect(page.getByText("Saved just now")).toBeVisible();
  await expectStoredName("Morgan Elsewhere");
});
