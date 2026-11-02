import { expect, test } from "@playwright/test";
import { Either, Schema } from "effect";
import { defineOperation } from "../../src/runtime/operation.js";
import { runExample } from "./authoring-fixture.js";

const origin = "https://apply.example.test";

// A tool clicks a link whose next page takes 1.5 s to start answering, with a 500 ms click
// timeout. Playwright clicks, then times out waiting for that page. The runtime counts the click
// as done once the page commits, so the run succeeds on the new page.
const openCourses = defineOperation(
  { input: Schema.Struct({}), output: Schema.String },
  async ({ kernel, sessionId, errors }) => {
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 10,
      code: `await page.getByRole("link", { name: "Add course" }).click({ timeout: 500 });
        return await page.getByRole("heading").textContent({ timeout: 500 });`,
    });
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    return String(answer.result);
  },
);

test("a click whose only timeout is its slow next page counts as done", async ({ page }) => {
  await page.context().route(`${origin}/**`, async (route) => {
    if (new URL(route.request().url()).pathname === "/courses") {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return route.fulfill({ contentType: "text/html", body: "<h1>Courses</h1>" });
    }
    return route.fulfill({ contentType: "text/html", body: `<a href="/courses">Add course</a>` });
  });
  await page.goto(`${origin}/`);
  const run = await runExample(page, openCourses, {}, { siteOrigin: origin });
  expect(run.result).toEqual(Either.right("Courses"));
});
