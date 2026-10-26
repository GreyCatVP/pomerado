import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Effect's virtual clock drains polls through real timer turns, which are coarser on Windows.
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
    include: ["typescript/tests/unit/**/*.test.ts"],
    allowOnly: !process.env["CI"],
    passWithNoTests: false,
    retry: 0,
    maxWorkers: 2,
    // Suspected destination-boundary bugs stop instead of continuing, locally as in CI.
    env: { POMERADO_BOUNDARY_STRICT: "1" },
  },
});
