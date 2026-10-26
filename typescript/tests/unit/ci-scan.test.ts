import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../tools/ci-scan.sh", import.meta.url));
const missing = "0123456789abcdef0123456789abcdef01234567";
const zeros = "0".repeat(40);
const treeScan = "dir --config .gitleaks.toml --redact --no-banner .";
const rangeScan = (range: string) =>
  `git --config .gitleaks.toml --redact --no-banner --log-opts=--remerge-diff ${range} .`;
// A stand-in secret. The emulating gitleaks below fails on any added line that holds it.
const canary = ["LEAK", "CANARY", "7f3a"].join("-");

interface Event {
  readonly EVENT?: string;
  readonly REF?: string;
  readonly PR_BASE?: string;
  readonly PR_HEAD?: string;
  readonly PUSH_BEFORE?: string;
  readonly PUSH_AFTER?: string;
  readonly GITLEAKS_EXIT?: string;
  readonly PATH?: string;
}

// These exercise the Linux CI's Bash scripts and executable shell stubs.
describe.skipIf(process.platform === "win32")("CI scan steps", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  const temporary = (prefix: string) => {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
  };

  /** Runs git in `cwd` as a fixed identity. */
  const gitIn =
    (cwd: string) =>
    (...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
        { cwd, encoding: "utf8" },
      ).trim();

  /** A stand-in for gitleaks that logs each call. With `emulate`, it reads git as gitleaks does. */
  const gitleaksStub = (emulate = false) => {
    const tools = temporary("ci-scan-tools-");
    const log = join(tools, "calls.log");
    const gitleaks = join(tools, "gitleaks");
    const detect = emulate
      ? [
          'for arg; do case $arg in --log-opts=*) opts=${arg#--log-opts=} ;; esac; done',
          // gitleaks reads `git log -p -U0` with the log options, and flags added lines.
          `if [ "$1" = git ]; then git log -p -U0 $opts | grep -q '^+.*${canary}' && exit 1; fi`,
          `if [ "$1" = dir ]; then grep -rq --exclude-dir=.git '${canary}' . && exit 1; fi`,
        ].join("\n")
      : "";
    writeFileSync(
      gitleaks,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${detect}\nexit "\${GITLEAKS_EXIT:-0}"\n`,
    );
    chmodSync(gitleaks, 0o755);
    return { gitleaks, log };
  };

  const runIn = (cwd: string, stub: { gitleaks: string; log: string }) => (mode: string, event: Event) => {
    rmSync(stub.log, { force: true });
    const result = spawnSync("bash", [script, mode], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "",
        GITLEAKS: stub.gitleaks,
        EVENT: "",
        REF: "",
        PR_BASE: "",
        PR_HEAD: "",
        PUSH_BEFORE: "",
        PUSH_AFTER: "",
        ...event,
      },
    });
    const calls = existsSync(stub.log) ? readFileSync(stub.log, "utf8").split("\n").filter(Boolean) : [];
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
  };

  /** A repository with a base commit and a head commit. */
  const setup = (message = "Change") => {
    const cwd = temporary("ci-scan-");
    const git = gitIn(cwd);
    git("init", "--quiet");
    git("commit", "--quiet", "--allow-empty", "--message", "Base");
    const base = git("rev-parse", "HEAD");
    git("commit", "--quiet", "--allow-empty", "--message", message);
    const head = git("rev-parse", "HEAD");
    return { cwd, base, head, run: runIn(cwd, gitleaksStub()) };
  };

  it("scans a pull request's commits and its tree", () => {
    const { base, head, run } = setup();
    const result = run("secrets", { EVENT: "pull_request", PR_BASE: base, PR_HEAD: head });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([rangeScan(`${base}..${head}`), treeScan]);
  });

  it("scans the commits pushed to main and the tree", () => {
    const { base, head, run } = setup();
    const push = { EVENT: "push", REF: "refs/heads/main", PUSH_BEFORE: base, PUSH_AFTER: head };
    const result = run("secrets", push);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([rangeScan(`${base}..${head}`), treeScan]);
  });

  it("scans only the tree for a release tag push, without a warning", () => {
    const { head, run } = setup();
    const tag = { EVENT: "push", REF: "refs/tags/v1.0.0", PUSH_BEFORE: zeros, PUSH_AFTER: head };
    const result = run("secrets", tag);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([treeScan]);
    expect(result.stderr).toBe("");
  });

  it("scans all history and the tree when a force push left no earlier commit", () => {
    const { head, run } = setup();
    const push = { EVENT: "push", REF: "refs/heads/main", PUSH_BEFORE: missing, PUSH_AFTER: head };
    const result = run("secrets", push);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([rangeScan(head), treeScan]);
    expect(result.stderr).toContain("::warning::");
    expect(run("range", push).stdout).toBe(`${head}\n`);
  });

  // Each case builds its event from the repository's base and head commits.
  it.each<[string, (base: string, head: string) => Event]>([
    ["a pull request base missing from the checkout", (_base, head) => ({ EVENT: "pull_request", PR_BASE: missing, PR_HEAD: head })],
    ["an empty pull request base", (_base, head) => ({ EVENT: "pull_request", PR_HEAD: head })],
    ["a pull request head missing from the checkout", (base) => ({ EVENT: "pull_request", PR_BASE: base, PR_HEAD: missing })],
    ["a pushed commit missing from the checkout", (base) => ({ EVENT: "push", REF: "refs/heads/main", PUSH_BEFORE: base, PUSH_AFTER: missing })],
  ])("fails before any scan for %s", (_label, event) => {
    const { base, head, run } = setup();
    for (const mode of ["range", "secrets", "content"]) {
      const result = run(mode, event(base, head));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("::error::");
      expect(result.calls).toEqual([]);
    }
  });

  it("fails before any scan in a shallow checkout, even with both ends present", () => {
    const source = setup();
    gitIn(source.cwd)("commit", "--quiet", "--allow-empty", "--message", "Later");
    const later = gitIn(source.cwd)("rev-parse", "HEAD");
    const clone = join(temporary("ci-scan-shallow-"), "clone");
    execFileSync("git", ["clone", "--quiet", "--depth", "2", `file://${source.cwd}`, clone]);
    expect(gitIn(clone)("rev-parse", "--is-shallow-repository")).toBe("true");
    const run = runIn(clone, gitleaksStub());
    for (const mode of ["range", "secrets", "content"]) {
      const result = run(mode, { EVENT: "pull_request", PR_BASE: source.head, PR_HEAD: later });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("shallow");
      expect(result.calls).toEqual([]);
    }
  });

  it("fails before the range scan when git can't show merges with --remerge-diff", () => {
    const { base, head, run } = setup();
    const bin = temporary("ci-scan-bin-");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nfor arg; do [ "$arg" = --remerge-diff ] && { echo "unknown option" >&2; exit 129; }; done\nexec '${realGit}' "$@"\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const event = { EVENT: "pull_request", PR_BASE: base, PR_HEAD: head, PATH: `${bin}:${process.env["PATH"] ?? ""}` };
    const result = run("secrets", event);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("2.36");
    expect(result.calls).toEqual([]);
  });

  /** A pull request whose merge adds the canary, then a later commit that removes it again. */
  const mergeThatAddsCanary = (conflict: boolean) => {
    const cwd = temporary("ci-scan-merge-");
    const git = gitIn(cwd);
    git("init", "--quiet", "--initial-branch", "main");
    writeFileSync(join(cwd, "f.txt"), "a = 1\n");
    git("add", "--all");
    git("commit", "--quiet", "--message", "Base");
    const base = git("rev-parse", "HEAD");
    git("checkout", "--quiet", "-b", "topic");
    writeFileSync(join(cwd, "f.txt"), "a = 2\n");
    git("commit", "--quiet", "--all", "--message", "Topic");
    git("checkout", "--quiet", "main");
    if (conflict) {
      writeFileSync(join(cwd, "f.txt"), "a = 3\n");
      git("commit", "--quiet", "--all", "--message", "Main");
      spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "merge", "--quiet", "topic"], { cwd });
      // The resolution adds the canary to the conflicted file.
      writeFileSync(join(cwd, "f.txt"), `a = 4\nkey = ${canary}\n`);
    } else {
      mkdirSync(join(cwd, "docs"));
      writeFileSync(join(cwd, "docs", "g.txt"), "b = 1\n");
      git("add", "--all");
      git("commit", "--quiet", "--message", "Main");
      git("merge", "--quiet", "--no-commit", "--no-ff", "topic");
      // A merge without conflicts can still add a file of its own.
      writeFileSync(join(cwd, "evil.txt"), `key = ${canary}\n`);
    }
    git("add", "--all");
    git("commit", "--quiet", "--no-edit", "--message", "Merge topic");
    expect(git("rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
    // A later commit takes the canary out again, so the tree no longer shows it.
    writeFileSync(join(cwd, "f.txt"), "a = 4\n");
    rmSync(join(cwd, "evil.txt"), { force: true });
    git("add", "--all");
    git("commit", "--quiet", "--message", "Remove");
    const head = git("rev-parse", "HEAD");
    return { cwd, base, head };
  };

  it.each([
    ["while resolving a conflict", true],
    ["as a new file in a merge without conflicts", false],
  ])("fails on a secret added %s and removed afterwards", (_label, conflict) => {
    const { cwd, base, head } = mergeThatAddsCanary(conflict);
    expect(readFileSync(join(cwd, "f.txt"), "utf8")).not.toContain(canary);
    const run = runIn(cwd, gitleaksStub(true));
    const result = run("secrets", { EVENT: "pull_request", PR_BASE: base, PR_HEAD: head });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([rangeScan(`${base}..${head}`)]);
  });

  it("fails when gitleaks reports a finding", () => {
    const { base, head, run } = setup();
    const pullRequest = { EVENT: "pull_request", PR_BASE: base, PR_HEAD: head, GITLEAKS_EXIT: "1" };
    expect(run("secrets", pullRequest).status).toBe(1);
    const tag = { EVENT: "push", REF: "refs/tags/v1.0.0", PUSH_AFTER: head, GITLEAKS_EXIT: "1" };
    expect(run("secrets", tag).status).toBe(1);
  });

  it("prints the range it scans", () => {
    const { base, head, run } = setup();
    expect(run("range", { EVENT: "pull_request", PR_BASE: base, PR_HEAD: head }).stdout).toBe(
      `${base}..${head}\n`,
    );
    expect(run("range", { EVENT: "workflow_dispatch" }).stdout).toBe("\n");
  });

  it("gives the content scan the same range", () => {
    const clean = setup();
    const event = { EVENT: "pull_request", PR_BASE: clean.base, PR_HEAD: clean.head };
    expect(clean.run("content", event).status).toBe(0);
    const flagged = setup(["Address review ", "P2", "-1"].join(""));
    const result = flagged.run("content", { ...event, PR_BASE: flagged.base, PR_HEAD: flagged.head });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`commit ${flagged.head.slice(0, 12)}:1:`);
  });

  it("exits with a usage error for an unknown mode", () => {
    expect(setup().run("all", {}).status).toBe(2);
  });
});
