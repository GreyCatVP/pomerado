import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { delimiter, join, resolve } from "node:path";

// TLS fixtures use OpenSSL. Git for Windows ships it outside the default PATH.
if (process.platform === "win32" && spawnSync("openssl", ["version"], { stdio: "ignore" }).status !== 0) {
  const git = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
  const bin = resolve(git, "../../../usr/bin");
  if (!existsSync(join(bin, "openssl.exe")))
    throw new Error("Browser TLS fixtures need OpenSSL on PATH (included with Git for Windows).");
  process.env["PATH"] = `${bin}${delimiter}${process.env["PATH"] ?? ""}`;
}

// Suspected destination-boundary bugs stop instead of continuing, locally as in CI. Workers
// inherit this process's environment.
process.env["POMERADO_BOUNDARY_STRICT"] ??= "1";

export default defineConfig({
  // Native browser startup and shutdown take longer on Windows; operation deadlines stay explicit.
  timeout: process.platform === "win32" ? 60_000 : 30_000,
  testDir: "./typescript/tests/browser",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ["json", { outputFile: "test-results/browser-results.json" }],
  ],
  metadata: {
    revision: process.env["GITHUB_SHA"] ?? "local-working-tree",
    command: "pnpm test:browser",
    fixtures: "typescript/tests/browser (controlled local fixtures)",
  },
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
