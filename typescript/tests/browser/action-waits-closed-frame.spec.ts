import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { waitCode } from "../../src/browser/wait.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";

// The outcome race, run as a Kernel call body runs it (`page` in scope), on a page whose
// cross-site frame goes away while the wait reads it. The frame must run in its own process, as
// a cross-site frame does in a browser with site isolation: Playwright then reports a read the
// frame's removal cut short as a closed target, not as a detached frame.
test.use({ launchOptions: { args: ["--site-per-process"] } });

const call = async (page: Page, body: string) => {
  const answer = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 10,
    code: `${waitCode}\n${body}`,
  });
  return answer.success ? { result: answer.result } : { error: String(answer.error) };
};

const origin = "https://apply.example.test";
const checkOrigin = "https://verification.test";

/**
 * An application form with a cross-site verification frame. Submit asks the frame to verify, and
 * the page removes the frame 300 ms later and shows its heading. The frame's script is busy until
 * then, so a read into the frame is still running when the frame goes.
 */
const applicationSite = async (page: Page) => {
  await page.context().route(`${checkOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<p>Verifying you are human</p>
        <script>
          addEventListener("message", () => { const end = Date.now() + 5000; while (Date.now() < end); });
        </script>`,
    }),
  );
  await page.context().route(`${origin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `
        <button type="button" id="submit">Submit application</button>
        <iframe id="verification" title="Verification" src="${checkOrigin}/widget"></iframe>
        <script>
          document.querySelector("#submit").onclick = () => {
            const frame = document.querySelector("#verification");
            // Once the click is handled, so Submit returns before the frame is busy.
            setTimeout(() => frame.contentWindow.postMessage("verify", "*"));
            setTimeout(() => {
              frame.remove();
              document.body.insertAdjacentHTML("beforeend", "<h1>Application received</h1>");
            }, 300);
          };
        </script>`,
    }),
  );
  await page.goto(`${origin}/`);
  await page.frameLocator("#verification").getByText("Verifying you are human").waitFor();
};

// The received heading or the site's error, after Submit. The error check reads every frame, as
// a status check over a page that embeds a widget does. The wait reads the outcomes highest
// priority last, so each look runs the check first. `after` runs once Submit returns.
const submit = (after = "") => `
  return await waitForOutcome({
    done: page.getByRole("heading", { name: "Application received" }),
    failed: {
      check: async () => {
        for (const frame of page.frames()) {
          const errors = await frame.$$eval("[role=alert]", (nodes) => nodes.map((node) => node.textContent));
          if (errors.length > 0) return errors[0];
        }
        return false;
      },
    },
  }, {
    action: async () => {
      await page.locator("#submit").click();
      ${after}
    },
    noProgressMs: 2000,
    timeout: 4000,
  });`;

test("a check reading a frame that closes loses that look, and the next look sees the outcome", async ({
  page,
}) => {
  await applicationSite(page);
  expect(await call(page, submit())).toEqual({ result: "done" });
});

test("a main page that closes during the wait still fails it", async ({ page }) => {
  await applicationSite(page);
  const answer = await call(page, submit(`setTimeout(() => page.close().catch(() => undefined), 100);`));
  expect(answer.error).toMatch(/Target page, context or browser has been closed/u);
});
