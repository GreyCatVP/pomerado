import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseCodeOwners } from "../../../tools/approval-gate.js";
import {
  checkName,
  isAddressed,
  parsePolicy,
  pathMatcher,
  pullsToEvaluate,
  readCoverage,
  runGate,
  severityOf,
  type Context,
  type GitHub,
  type ReviewThread,
} from "../../../tools/review-gate.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const script = join(root, "tools", "review-gate.ts");
const repo = "example-org/example-repo";
const head = "a".repeat(40);
const earlier = "b".repeat(40);
const appId = "4242";
const detailsUrl = "https://github.example/runs/1";
const policy = parsePolicy(readFileSync(join(root, ".github", "review-gate.json"), "utf8"));
const context: Context = { repo, defaultBranch: "main", policy, codeOwners: ["owner-one", "owner-two"] };
const permissions: Readonly<Record<string, string>> = { "owner-one": "admin", "owner-two": "write", "outside-dev": "read" };

interface Pull {
  readonly number: number;
  readonly author: string;
  readonly sha?: string;
  readonly base?: string;
  readonly draft?: boolean;
  readonly state?: string;
  readonly additions?: number;
  readonly deletions?: number;
  /** Changed files. Each lists its path, and a rename its old one. */
  readonly files?: readonly { readonly filename: string; readonly previous_filename?: string }[];
  /** How many files GitHub says changed, when it is more than `files` lists. */
  readonly changedFiles?: number;
  readonly comments?: readonly Comment[];
  readonly threads?: readonly ReviewThread[];
  /** CodeRabbit's or anyone's reviews, by their summary. */
  readonly reviews?: readonly Comment[];
}

interface Comment {
  readonly login: string;
  readonly type?: string;
  readonly body: string;
  readonly updated?: string;
}

interface CheckRun {
  readonly id: number;
  readonly status: string;
  readonly conclusion: string | null;
  readonly external_id: string | null;
  readonly output: { readonly title: string; readonly summary: string };
}

interface CompareFile {
  readonly filename: string;
  readonly status: string;
  readonly sha?: string | null;
  readonly previous_filename?: string;
}

interface Fixture {
  readonly pulls: readonly Pull[];
  /** The reviewer App's check runs per commit. */
  readonly checkRuns?: Readonly<Record<string, readonly CheckRun[]>>;
  /** Review threads per GraphQL page, when a test pages through them. */
  readonly threadPages?: readonly (readonly ReviewThread[])[];
  /** What the compare API answers for `base...head`: the merge base and the files. */
  readonly compare?: Readonly<Record<string, { readonly mergeBase: string; readonly files: readonly CompareFile[] }>>;
}

/** CodeRabbit's walkthrough comment, shaped as it writes it. */
const walkthrough = (
  options: {
    readonly covered?: string;
    readonly source?: string;
    readonly kind?: string;
    readonly risk?: string | undefined;
    readonly checks?: readonly (readonly [string, string])[];
    readonly extra?: string;
  } = {},
) => {
  const covered = options.covered ?? head;
  const risk = "risk" in options ? options.risk : "⚪ Minimal";
  return [
    "<!-- coderabbit-ai-generated:v1 -->",
    "",
    "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->",
    "<!-- walkthrough_start -->",
    "## Walkthrough",
    "The parser keeps the last item of a list.",
    options.extra ?? "",
    "<!-- walkthrough_end -->",
    "<!-- final_review_risk_start -->",
    "",
    "<!-- final_review_risk_label",
    ...(risk === undefined ? [] : [`**Merge Risk:** **${risk}** · up to \`${covered.slice(0, 5)}\``]),
    "-->",
    `<!-- final_review_risk_coverage:${JSON.stringify({ sourceCommitId: options.source ?? covered, coveredCommitId: covered, kind: options.kind ?? "reviewed" })} -->`,
    "",
    "The change presents no identified merge-blocking risk.",
    "<!-- final_review_risk_end -->",
    "<!-- pre_merge_checks_walkthrough_start -->",
    "| Check name | Status | Explanation |",
    "| :-- | :--: | :-- |",
    ...(options.checks ?? [["Title check", "Passed"]]).map(
      ([name, status]) => `| ${name} | ![${status}](https://example.invalid/pre-merge-checks-${status.toLowerCase()}.svg) | Why. |`,
    ),
    "<!-- pre_merge_checks_walkthrough_end -->",
  ].join("\n");
};

const reviewer = (body: string, updated = "2026-10-01T10:00:00Z"): Comment => ({
  login: "coderabbitai[bot]",
  type: "Bot",
  body,
  updated,
});

/** One of CodeRabbit's inline findings, as GraphQL reports its thread. */
const finding = (
  options: {
    readonly severity?: string;
    readonly resolvedBy?: string;
    readonly addressed?: boolean;
    /** Contributor code CodeRabbit quotes in its proposed fix. */
    readonly quoted?: string;
    readonly author?: { readonly __typename: string; readonly login: string };
    readonly path?: string;
    readonly line?: number | null;
  } = {},
): ReviewThread => {
  const label = options.severity === undefined ? "**🟠 Major**" : options.severity;
  return {
    isResolved: options.resolvedBy !== undefined,
    resolvedBy: options.resolvedBy === undefined ? null : { login: options.resolvedBy },
    path: options.path ?? "typescript/src/runtime/list.ts",
    line: options.line === undefined ? 12 : options.line,
    originalLine: 10,
    comments: {
      nodes: [
        {
          author: options.author ?? { __typename: "Bot", login: "coderabbitai" },
          body: [
            "<!-- coderabbit-ai-generated:v1 -->",
            `**🎯 Functional Correctness** | ${label} | **⚡ Quick win**`,
            "",
            "The loop stops one item early.",
            ...(options.quoted === undefined ? [] : ["", "```diff", `- ${options.quoted}`, "+ for (const item of items) {", "```"]),
            "",
            "<!-- This is an auto-generated comment by CodeRabbit -->",
            ...(options.addressed === true ? ["", "✅ Addressed in commit 1234567"] : []),
          ].join("\n"),
          url: `https://github.example/${repo}/pull/7/files/r1`,
        },
      ],
    },
  };
};

const pullJson = (pull: Pull) => ({
  number: pull.number,
  state: pull.state ?? "open",
  draft: pull.draft ?? false,
  user: { login: pull.author },
  head: { sha: pull.sha ?? head },
  base: { ref: pull.base ?? "main" },
  additions: pull.additions ?? 20,
  deletions: pull.deletions ?? 4,
  changed_files: pull.changedFiles ?? (pull.files ?? [{ filename: "typescript/src/runtime/list.ts" }]).length,
});

/** Answers requests the way GitHub's API does for the fixture, and records what is posted. */
const fakeApi = (fixture: Fixture) => {
  const posted: { path: string; body: unknown }[] = [];
  const patched: { path: string; body: unknown }[] = [];
  const pullPath = /^\/repos\/example-org\/example-repo\/pulls\/(\d+)(\/files|\/reviews)?$/;
  const compare = /^\/repos\/example-org\/example-repo\/compare\/(.+)$/;
  const comments = /^\/repos\/example-org\/example-repo\/issues\/(\d+)\/comments$/;
  const permission = /^\/repos\/example-org\/example-repo\/collaborators\/([^/]+)\/permission$/;
  const checks = /^\/repos\/example-org\/example-repo\/commits\/([0-9a-f]{40})\/check-runs$/;
  const find = (number: string | undefined) => fixture.pulls.find((pull) => pull.number === Number(number));
  let graphPage = 0;
  const get = (path: string): unknown => {
    const [pathname = "", query = ""] = path.split("?");
    if (new URLSearchParams(query).get("page") === "2") return [];
    if (pathname === `/repos/${repo}`) return { default_branch: "main" };
    if (pathname === `/repos/${repo}/pulls`) {
      return fixture.pulls.filter((pull) => (pull.state ?? "open") === "open").map(pullJson);
    }
    const pullMatch = pullPath.exec(pathname);
    if (pullMatch !== null) {
      const pull = find(pullMatch[1]);
      if (pull === undefined) return undefined;
      if (pullMatch[2] === "/reviews") {
        return (pull.reviews ?? []).map((review, index) => ({
          user: { login: review.login, type: review.type ?? "User" },
          body: review.body,
          html_url: `https://github.example/${repo}/pull/7/reviews/${index}`,
        }));
      }
      return pullMatch[2] === undefined ? pullJson(pull) : (pull.files ?? [{ filename: "typescript/src/runtime/list.ts" }]);
    }
    const commentMatch = comments.exec(pathname);
    if (commentMatch !== null) {
      return (find(commentMatch[1])?.comments ?? []).map((comment) => ({
        user: { login: comment.login, type: comment.type ?? "User" },
        body: comment.body,
        updated_at: comment.updated ?? "2026-10-01T10:00:00Z",
      }));
    }
    const compared = compare.exec(pathname)?.[1];
    if (compared !== undefined) {
      const answer = fixture.compare?.[decodeURIComponent(compared)];
      return answer === undefined ? undefined : { merge_base_commit: { sha: answer.mergeBase }, files: answer.files };
    }
    const user = permission.exec(pathname)?.[1];
    if (user !== undefined) {
      const level = permissions[decodeURIComponent(user).toLowerCase()];
      return level === undefined ? undefined : { permission: level };
    }
    const sha = checks.exec(pathname)?.[1];
    if (sha !== undefined) {
      const params = new URLSearchParams(query);
      if (params.get("check_name") !== checkName || params.get("app_id") !== appId) {
        throw new Error(`Unexpected check run query ${query}`);
      }
      return { check_runs: fixture.checkRuns?.[sha] ?? [] };
    }
    throw new Error(`Unexpected request for ${path}`);
  };
  const post = (path: string, body: unknown): unknown => {
    if (path === "/graphql") {
      const { variables } = body as { readonly variables: { readonly number: number; readonly after: string | null } };
      if (fixture.threadPages !== undefined) {
        const page = fixture.threadPages[graphPage] ?? [];
        graphPage += 1;
        const more = graphPage < fixture.threadPages.length;
        return reviewThreadPage(page, more ? `cursor-${graphPage}` : null);
      }
      return reviewThreadPage(find(String(variables.number))?.threads ?? [], null);
    }
    posted.push({ path, body });
    return { id: 1 };
  };
  const patch = (path: string, body: unknown): unknown => {
    patched.push({ path, body });
    return { id: 1 };
  };
  return { get, post, patch, posted, patched };
};

const reviewThreadPage = (nodes: readonly ReviewThread[], endCursor: string | null) => ({
  data: {
    repository: {
      pullRequest: { reviewThreads: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes } },
    },
  },
});

type Recorded = { path: string; body: unknown }[];
const gitHub = (fixture: Fixture): GitHub & { readonly posted: Recorded; readonly patched: Recorded } => {
  const api = fakeApi(fixture);
  return {
    get: async (path) => api.get(path),
    list: async (path) => api.get(path) as unknown[],
    post: async (path, body) => api.post(path, body),
    patch: async (path, body) => api.patch(path, body),
    posted: api.posted,
    patched: api.patched,
  };
};

/** Runs the gate for a pull request event on an outside contributor's pull request, numbered 7. */
const gate = async (pull: Omit<Pull, "number" | "author"> & { readonly author?: string }, fixture: Omit<Fixture, "pulls"> = {}) => {
  const api = gitHub({ ...fixture, pulls: [{ number: 7, author: "outside-dev", ...pull }] });
  const results = await runGate(api, context, "pull_request_target", { pull_request: { number: 7 } }, appId, detailsUrl);
  return { result: results[0], posted: api.posted, patched: api.patched };
};

const checkBody = (posted: readonly { path: string; body: unknown }[]) => {
  expect(posted).toHaveLength(1);
  expect(posted[0]?.path).toBe(`/repos/${repo}/check-runs`);
  return posted[0]?.body as {
    readonly name: string;
    readonly head_sha: string;
    readonly status: string;
    readonly conclusion?: string;
    readonly external_id: string;
    readonly details_url: string;
    readonly output: { readonly title: string; readonly summary: string };
  };
};

describe("review gate", () => {
  it("posts CLEAR once CodeRabbit reviewed the head commit and left nothing blocking", async () => {
    const { posted } = await gate({ comments: [reviewer(walkthrough())] });
    expect(checkBody(posted)).toEqual({
      name: "review/clear",
      head_sha: head,
      status: "completed",
      conclusion: "success",
      external_id: "lane=coderabbit;round=1",
      details_url: detailsUrl,
      output: {
        title: "CLEAR from coderabbit, round 1",
        summary: expect.stringContaining(`CodeRabbit reviewed \`${head}\``),
      },
    });
  });

  it("leaves a maintainer's pull request to the independent review", async () => {
    for (const author of ["owner-one", "Owner-Two"]) {
      const { result, posted } = await gate({ author, comments: [reviewer(walkthrough())] });
      expect(result).toMatchObject({ action: "skipped", outcome: { kind: "skip" } });
      expect(posted).toEqual([]);
    }
  });

  it("reviews a listed code owner who has lost write access like any outside contributor", async () => {
    const api = gitHub({ pulls: [{ number: 7, author: "owner-three", comments: [reviewer(walkthrough())] }] });
    const results = await runGate(
      api,
      { ...context, codeOwners: [...context.codeOwners, "owner-three"] },
      "pull_request_target",
      { pull_request: { number: 7 } },
      appId,
      detailsUrl,
    );
    expect(results[0]?.outcome.kind).toBe("clear");
  });

  it("skips a pull request into another branch, and one a maintainer's pull request shares a commit with", async () => {
    const { posted } = await gate({ base: "release", comments: [reviewer(walkthrough())] });
    expect(posted).toEqual([]);
    const api = gitHub({
      pulls: [
        { number: 7, author: "outside-dev", comments: [reviewer(walkthrough())] },
        { number: 8, author: "owner-one" },
      ],
    });
    const results = await runGate(api, context, "pull_request_target", { pull_request: { number: 7 } }, appId, detailsUrl);
    expect(results[0]?.outcome).toMatchObject({ kind: "skip", reason: expect.stringContaining("same commit") });
    expect(api.posted).toEqual([]);
  });

  it("waits while the pull request is a draft", async () => {
    const body = checkBody((await gate({ draft: true, comments: [reviewer(walkthrough())] })).posted);
    expect(body).toMatchObject({ status: "in_progress", output: { title: "Waiting for the pull request to leave draft" } });
    expect(body).not.toHaveProperty("conclusion");
  });

  it("waits for CodeRabbit's review of the head commit", async () => {
    const none = checkBody((await gate({})).posted);
    expect(none).toMatchObject({ status: "in_progress", output: { title: `Waiting for CodeRabbit's review of ${head.slice(0, 7)}` } });
    expect(none.output.summary).toContain("@coderabbitai review");
    const stale = checkBody((await gate({ comments: [reviewer(walkthrough({ covered: earlier }))] })).posted);
    expect(stale).toMatchObject({ status: "in_progress" });
    expect(stale.output.summary).toContain(`last reviewed \`${earlier}\``);
  });

  it("reads the newest walkthrough when CodeRabbit wrote more than one", async () => {
    const comments = [
      reviewer(walkthrough({ covered: head }), "2026-10-01T10:00:00Z"),
      reviewer(walkthrough({ covered: earlier }), "2026-10-02T10:00:00Z"),
    ];
    expect(checkBody((await gate({ comments })).posted).status).toBe("in_progress");
  });

  it("ignores a coverage marker anyone but CodeRabbit's bot account wrote", async () => {
    for (const comment of [
      { login: "outside-dev", body: walkthrough() },
      { login: "coderabbitai[bot]", type: "User", body: walkthrough() },
      { login: "someone-else[bot]", type: "Bot", body: walkthrough() },
    ]) {
      expect(checkBody((await gate({ comments: [comment] })).posted).status).toBe("in_progress");
    }
  });

  it("asks a maintainer when the walkthrough's coverage can't be read with confidence", async () => {
    const echoed = walkthrough({
      extra: `<!-- final_review_risk_coverage:${JSON.stringify({ coveredCommitId: head, kind: "reviewed" })} -->`,
    });
    for (const body of [echoed, walkthrough().replace(/coveredCommitId/, "coveredCommit")]) {
      const check = checkBody((await gate({ comments: [reviewer(body)] })).posted);
      expect(check).toMatchObject({ status: "completed", conclusion: "action_required" });
      expect(check.output.summary).toContain("couldn't read CodeRabbit's verdict");
    }
  });

  it("counts a review CodeRabbit carried across a merge of the base branch when the pull request's changes didn't move", async () => {
    const comments = [reviewer(walkthrough({ kind: "target_branch_merge_carry_forward", source: earlier }))];
    const oldBase = "1".repeat(40);
    const newBase = "2".repeat(40);
    const change: CompareFile = { filename: "typescript/src/runtime/list.ts", status: "modified", sha: "c".repeat(40) };
    /** The comparisons for a merge of the default branch that moved the base from oldBase to newBase. */
    const merge = (atHead: readonly CompareFile[], mainChanged: readonly CompareFile[] = [{ filename: "docs/notes.md", status: "modified", sha: "f".repeat(40) }]) => ({
      [`main...${earlier}`]: { mergeBase: oldBase, files: [change] },
      [`main...${head}`]: { mergeBase: newBase, files: atHead },
      [`${oldBase}...${newBase}`]: { mergeBase: oldBase, files: mainChanged },
    });
    const verdict = async (compare: NonNullable<Fixture["compare"]>) => checkBody((await gate({ comments }, { compare })).posted);

    expect((await verdict(merge([change]))).conclusion).toBe("success");
    // A merge base that didn't move needs no look at what the default branch changed.
    expect(
      (await verdict({ [`main...${earlier}`]: { mergeBase: oldBase, files: [change] }, [`main...${head}`]: { mergeBase: oldBase, files: [change] } }))
        .conclusion,
    ).toBe("success");

    for (const compare of [
      // The merge changed a file the pull request touches, brought a file of its own, or renamed one.
      merge([{ ...change, sha: "d".repeat(40) }]),
      merge([change, { filename: "typescript/src/runtime/extra.ts", status: "added", sha: "e".repeat(40) }]),
      merge([{ ...change, status: "renamed" }]),
      // The merge kept the pull request's version of a file the default branch changed, undoing that change.
      merge([change], [{ ...change, sha: "9".repeat(40) }]),
      merge([change], [{ filename: "typescript/src/runtime/lists.ts", status: "renamed", previous_filename: change.filename }]),
      // A file without a blob proves nothing.
      merge([{ ...change, sha: null }]),
    ]) {
      const check = await verdict(compare);
      expect(check).toMatchObject({ conclusion: "action_required" });
      expect(check.output.summary).toContain("doesn't change every file the same way");
    }
    // A comparison GitHub may have cut short, or can't answer, can't vouch for the merge.
    const many = Array.from({ length: 300 }, (_, index) => ({ ...change, filename: `docs/file-${index}.md` }));
    expect((await verdict({ [`main...${earlier}`]: { mergeBase: oldBase, files: many }, [`main...${head}`]: { mergeBase: newBase, files: many } })).conclusion).toBe(
      "action_required",
    );
    const { [`${oldBase}...${newBase}`]: _moved, ...unanswered } = merge([change]);
    expect((await verdict(unanswered)).conclusion).toBe("action_required");
  });

  it("asks a maintainer about any other kind of pass, or a review of another commit than it covers", async () => {
    const other = checkBody((await gate({ comments: [reviewer(walkthrough({ kind: "skipped" }))] })).posted);
    expect(other).toMatchObject({ conclusion: "action_required" });
    expect(other.output.summary).toContain("`skipped`");
    const mismatched = await gate({ comments: [reviewer(walkthrough({ source: earlier }))] });
    expect(checkBody(mismatched.posted).conclusion).toBe("action_required");
  });

  it("asks a maintainer when CodeRabbit rates the merge risk above what the policy clears", async () => {
    for (const risk of ["🟠 High", "🔴 Critical", "Unheard", undefined]) {
      const check = checkBody((await gate({ comments: [reviewer(walkthrough({ risk }))] })).posted);
      expect(check).toMatchObject({ conclusion: "action_required" });
    }
    for (const risk of ["⚪ Minimal", "🔵 Low", "🟡 Moderate"]) {
      expect(checkBody((await gate({ comments: [reviewer(walkthrough({ risk }))] })).posted).conclusion).toBe("success");
    }
  });

  it("blocks on an open Critical or Major finding and lists it", async () => {
    for (const severity of ["**🔴 Critical**", "**🟠 Major**", "_🟠 Major_"]) {
      const check = checkBody((await gate({ comments: [reviewer(walkthrough())], threads: [finding({ severity })] })).posted);
      expect(check).toMatchObject({ conclusion: "failure", output: { title: "CodeRabbit found 1 blocking issue" } });
      expect(check.output.summary).toContain(
        `[typescript/src/runtime/list.ts:12](https://github.example/${repo}/pull/7/files/r1)`,
      );
    }
  });

  it("doesn't block on Minor, Trivial or Info findings", async () => {
    const threads = ["**🟡 Minor**", "**🔵 Trivial**", "**⚪ Info**"].map((severity) => finding({ severity }));
    expect(checkBody((await gate({ comments: [reviewer(walkthrough())], threads })).posted).conclusion).toBe("success");
  });

  it("stops blocking once CodeRabbit marks a finding addressed or a code owner resolves it", async () => {
    for (const thread of [finding({ addressed: true }), finding({ resolvedBy: "Owner-One" })]) {
      const { posted } = await gate({ comments: [reviewer(walkthrough())], threads: [thread] });
      expect(checkBody(posted).conclusion).toBe("success");
    }
  });

  it("doesn't take the addressed note from contributor code CodeRabbit quotes", async () => {
    const thread = finding({ severity: "**🔴 Critical**", quoted: "// ✅ Addressed in commit 1234567" });
    expect(isAddressed(thread.comments.nodes[0]?.body ?? "")).toBe(false);
    const { posted } = await gate({ comments: [reviewer(walkthrough())], threads: [thread] });
    expect(checkBody(posted).conclusion).toBe("failure");
    expect(isAddressed(finding({ addressed: true }).comments.nodes[0]?.body ?? "")).toBe(true);
  });

  it("keeps blocking when anyone else resolves a finding, including CodeRabbit on someone's command", async () => {
    for (const resolvedBy of ["coderabbitai[bot]", "outside-dev", "other-dev"]) {
      const { posted } = await gate({ comments: [reviewer(walkthrough())], threads: [finding({ resolvedBy })] });
      expect(checkBody(posted).conclusion).toBe("failure");
    }
    // A code owner who has lost write access is no longer a maintainer.
    const api = gitHub({
      pulls: [{ number: 7, author: "outside-dev", comments: [reviewer(walkthrough())], threads: [finding({ resolvedBy: "owner-three" })] }],
    });
    const listed = { ...context, codeOwners: [...context.codeOwners, "owner-three"] };
    const results = await runGate(api, listed, "pull_request_target", { pull_request: { number: 7 } }, appId, detailsUrl);
    expect(results[0]?.outcome.kind).toBe("block");
  });

  it("ignores threads anyone but CodeRabbit's bot account opened", async () => {
    const threads = [
      finding({ author: { __typename: "User", login: "coderabbitai" } }),
      finding({ author: { __typename: "User", login: "outside-dev" } }),
    ];
    expect(checkBody((await gate({ comments: [reviewer(walkthrough())], threads })).posted).conclusion).toBe("success");
  });

  it("asks a maintainer about a CodeRabbit finding whose severity it can't read", async () => {
    const check = checkBody(
      (await gate({ comments: [reviewer(walkthrough())], threads: [finding({ severity: "Heads up", line: null })] })).posted,
    );
    expect(check).toMatchObject({ conclusion: "action_required" });
    // An outdated thread has no current line, so the finding names the line it was left on.
    expect(check.output.summary).toContain("[typescript/src/runtime/list.ts:10](");
  });

  it("blocks on a pre-merge check that errored, and ignores warnings", async () => {
    const errored = walkthrough({ checks: [["Repository rules", "Error"], ["Description check", "Warning"]] });
    const check = checkBody((await gate({ comments: [reviewer(errored)] })).posted);
    expect(check).toMatchObject({ conclusion: "failure" });
    expect(check.output.summary).toContain("Pre-merge check errored: Repository rules");
    expect(check.output.summary).not.toContain("Description check");
    const warned = walkthrough({ checks: [["Description check", "Warning"]] });
    expect(checkBody((await gate({ comments: [reviewer(warned)] })).posted).conclusion).toBe("success");
  });

  it("asks a maintainer about blocking findings CodeRabbit could only put in a review's summary", async () => {
    const outsideDiff = [
      "**Actionable comments posted: 1**",
      "> **⚠️ Outside diff range comments (1)**",
      "> <summary><strong>🟠 Major</strong> · Close the file on every path. · <code>list.ts:40</code></summary>",
    ].join("\n");
    const duplicate = "<summary>♻️ Duplicate comments (1)</summary>\n`12-14`: **🎯 Functional Correctness** | **🔴 Critical**";
    for (const body of [outsideDiff, duplicate]) {
      const check = checkBody((await gate({ comments: [reviewer(walkthrough())], reviews: [reviewer(body)] })).posted);
      expect(check).toMatchObject({ conclusion: "action_required" });
      expect(check.output.summary).toContain(`https://github.example/${repo}/pull/7/reviews/0`);
    }
    // Nitpicks don't block, and nobody else's review speaks for CodeRabbit.
    const reviews = [reviewer("🧹 Nitpick comments (1)\n**🟡 Minor**"), { login: "outside-dev", body: outsideDiff }];
    expect(checkBody((await gate({ comments: [reviewer(walkthrough())], reviews })).posted).conclusion).toBe("success");
  });

  it("asks a maintainer when another outside pull request is at the same head commit", async () => {
    const api = gitHub({
      pulls: [
        { number: 7, author: "outside-dev", comments: [reviewer(walkthrough())] },
        { number: 8, author: "another-dev" },
      ],
    });
    const results = await runGate(api, context, "pull_request_target", { pull_request: { number: 7 } }, appId, detailsUrl);
    expect(results[0]?.outcome).toMatchObject({ kind: "maintainer", summary: expect.stringContaining("(8)") });
  });

  it("reads coverage only from CodeRabbit's walkthrough, and only inside its merge risk section", async () => {
    const chat = reviewer(
      `<!-- final_review_risk_coverage:${JSON.stringify({ sourceCommitId: head, coveredCommitId: head, kind: "reviewed" })} -->`,
      "2026-10-03T10:00:00Z",
    );
    expect(checkBody((await gate({ comments: [chat] })).posted).status).toBe("in_progress");
    expect(checkBody((await gate({ comments: [reviewer(walkthrough({ covered: earlier })), chat] })).posted).status).toBe(
      "in_progress",
    );
    const moved = walkthrough().replace("<!-- final_review_risk_end -->", "").replace("<!-- pre_merge_checks_walkthrough_start -->", "<!-- final_review_risk_end -->\n<!-- pre_merge_checks_walkthrough_start -->");
    const outside = walkthrough().replace(/(<!-- final_review_risk_coverage:[^>]*-->)/, "").replace("<!-- walkthrough_end -->", `${/<!-- final_review_risk_coverage:[^>]*-->/.exec(walkthrough())?.[0] ?? ""}\n<!-- walkthrough_end -->`);
    expect(checkBody((await gate({ comments: [reviewer(moved)] })).posted).conclusion).toBe("success");
    expect(checkBody((await gate({ comments: [reviewer(outside)] })).posted).conclusion).toBe("action_required");
  });

  it("reads review threads across pages", async () => {
    const pages = [[finding({ severity: "**🟡 Minor**" })], [finding()]];
    const { posted } = await gate({ comments: [reviewer(walkthrough())] }, { threadPages: pages });
    expect(checkBody(posted).conclusion).toBe("failure");
  });

  it("asks a maintainer about changes to paths the policy lists, including a renamed file's old path", async () => {
    const files = [
      { filename: "typescript/src/runtime/list.ts" },
      { filename: ".github/workflows/check.yml" },
      { filename: "docs/notes.md", previous_filename: "typescript/src/guardian/policy.md" },
      { filename: "docs/AGENTS.md" },
    ];
    const check = checkBody((await gate({ files, comments: [reviewer(walkthrough())] })).posted);
    expect(check).toMatchObject({ conclusion: "action_required", output: { title: "A maintainer reviews this pull request" } });
    for (const path of [".github/workflows/check.yml", "typescript/src/guardian/policy.md", "docs/AGENTS.md"]) {
      expect(check.output.summary).toContain(`\`${path}\``);
    }
    expect(check.output.summary).not.toContain("`docs/notes.md`");
  });

  it("asks a maintainer about a pull request too large for the automated review, or with files GitHub doesn't list", async () => {
    const large = checkBody((await gate({ additions: 700, deletions: 101, comments: [reviewer(walkthrough())] })).posted);
    expect(large).toMatchObject({ conclusion: "action_required" });
    expect(large.output.summary).toContain("801 lines");
    expect(checkBody((await gate({ additions: 700, deletions: 100, comments: [reviewer(walkthrough())] })).posted).conclusion).toBe(
      "success",
    );
    const truncated = checkBody((await gate({ changedFiles: 3001, comments: [reviewer(walkthrough())] })).posted);
    expect(truncated).toMatchObject({ conclusion: "action_required" });
  });

  it("never overwrites a maintainer's verdict on the head commit", async () => {
    const maintainerClear: CheckRun = {
      id: 9,
      status: "completed",
      conclusion: "success",
      external_id: "lane=root;round=1",
      output: { title: "CLEAR from root, round 1", summary: "Reviewed." },
    };
    const { result, posted } = await gate(
      { comments: [reviewer(walkthrough())], threads: [finding()] },
      { checkRuns: { [head]: [{ ...maintainerClear, id: 3, external_id: "lane=coderabbit;round=1" }, maintainerClear] } },
    );
    expect(result?.action).toBe("maintainer-verdict");
    expect(posted).toEqual([]);
  });

  it("posts only when its verdict changed", async () => {
    const first = await gate({ comments: [reviewer(walkthrough())] });
    const body = checkBody(first.posted);
    const standing: CheckRun = {
      id: 5,
      status: body.status,
      conclusion: body.conclusion ?? null,
      external_id: body.external_id,
      output: body.output,
    };
    const again = await gate({ comments: [reviewer(walkthrough())] }, { checkRuns: { [head]: [standing] } });
    expect(again.result?.action).toBe("unchanged");
    expect(again.posted).toEqual([]);
    const changed = await gate(
      { comments: [reviewer(walkthrough())], threads: [finding()] },
      { checkRuns: { [head]: [standing] } },
    );
    expect(checkBody(changed.posted).conclusion).toBe("failure");
  });

  it("finishes its own waiting check in place instead of posting another", async () => {
    const waiting: CheckRun = {
      id: 11,
      status: "in_progress",
      conclusion: null,
      external_id: "lane=coderabbit;round=1",
      output: { title: `Waiting for CodeRabbit's review of ${head.slice(0, 7)}`, summary: "Waiting." },
    };
    const { result, posted, patched } = await gate({ comments: [reviewer(walkthrough())] }, { checkRuns: { [head]: [waiting] } });
    expect(result?.action).toBe("updated");
    expect(posted).toEqual([]);
    expect(patched).toEqual([
      {
        path: `/repos/${repo}/check-runs/11`,
        body: expect.objectContaining({ status: "completed", conclusion: "success", external_id: "lane=coderabbit;round=1" }),
      },
    ]);
    expect(patched[0]?.body).not.toHaveProperty("head_sha");
  });

  it("evaluates the pull requests an event names", () => {
    const open = [
      pullJson({ number: 6, author: "outside-dev", sha: earlier }),
      pullJson({ number: 7, author: "outside-dev" }),
      pullJson({ number: 8, author: "outside-dev" }),
    ];
    expect(pullsToEvaluate("pull_request_target", { pull_request: { number: 7 } }, open)).toEqual([7]);
    expect(pullsToEvaluate("issue_comment", { issue: { number: 7, pull_request: {} } }, open)).toEqual([7]);
    expect(pullsToEvaluate("issue_comment", { issue: { number: 9 } }, open)).toEqual([]);
    expect(() => pullsToEvaluate("workflow_run", { workflow_run: { head_sha: head } }, open)).toThrow("doesn't handle");
    expect(pullsToEvaluate("workflow_dispatch", { inputs: { pull_request: "" } }, open)).toEqual([6, 7, 8]);
    expect(pullsToEvaluate("workflow_dispatch", {}, open)).toEqual([6, 7, 8]);
    expect(pullsToEvaluate("workflow_dispatch", { inputs: { pull_request: " 8 " } }, open)).toEqual([8]);
    expect(() => pullsToEvaluate("workflow_dispatch", { inputs: { pull_request: "8; rm" } }, open)).toThrow("must be a number");
    expect(() => pullsToEvaluate("push", {}, open)).toThrow("doesn't handle push");
  });
});

describe("review gate parsing", () => {
  it("reads the coverage, merge risk and errored checks from a walkthrough", () => {
    const body = walkthrough({ risk: "🟡 Moderate", checks: [["Repository rules", "Error"], ["Title check", "Passed"]] });
    expect(readCoverage([{ ...reviewer(body), user: { login: "coderabbitai[bot]", type: "Bot" }, updated_at: "2026-10-01T10:00:00Z" }], policy.reviewer)).toEqual({
      commit: head,
      source: head,
      kind: "reviewed",
      mergeRisk: "Moderate",
      erroredChecks: ["Repository rules"],
    });
    expect(readCoverage([], policy.reviewer)).toBeUndefined();
  });

  it("reads a finding's severity in CodeRabbit's current and earlier formats", () => {
    expect(severityOf("**🎯 Functional Correctness** | **🟠 Major** | **⚡ Quick win**")).toBe("Major");
    expect(severityOf("_⚠️ Potential issue_ | _🔴 Critical_")).toBe("Critical");
    expect(severityOf("**📐 Maintainability** | **🟡 Minor**")).toBe("Minor");
    expect(severityOf("<summary><strong>🟠 Major</strong> · Bound the query.</summary>")).toBe("Major");
    expect(severityOf("A Major problem, without a label.")).toBeUndefined();
  });

  it("matches policy globs against whole repository paths", () => {
    const matches = pathMatcher([".github/**", "**/AGENTS.md", "*.config.ts", "tsconfig*.json", "typescript/src/guardian/**"]);
    for (const path of [
      ".github/workflows/check.yml",
      "AGENTS.md",
      "docs/deep/AGENTS.md",
      "vitest.config.ts",
      "tsconfig.test.json",
      "typescript/src/guardian/review.ts",
    ]) {
      expect(matches(path), path).toBe(true);
    }
    for (const path of ["github/workflows/check.yml", "docs/vitest.config.ts", "AGENTS.mdx", "typescript/src/guardianship.ts"]) {
      expect(matches(path), path).toBe(false);
    }
  });

  it("refuses a malformed policy", () => {
    const valid = JSON.parse(readFileSync(join(root, ".github", "review-gate.json"), "utf8")) as Record<string, unknown>;
    expect(() => parsePolicy("[]")).toThrow("JSON object");
    expect(() => parsePolicy(JSON.stringify({ ...valid, reviewer: "coderabbitai" }))).toThrow("bot account");
    expect(() => parsePolicy(JSON.stringify({ ...valid, lane: "a;b" }))).toThrow("lane");
    expect(() => parsePolicy(JSON.stringify({ ...valid, blockingSeverities: [] }))).toThrow("blockingSeverities");
    expect(() => parsePolicy(JSON.stringify({ ...valid, maintainerReview: { maxChangedLines: 0, paths: [] } }))).toThrow(
      "maxChangedLines",
    );
  });
});

describe("review gate configuration", () => {
  const read = (path: string) => readFileSync(join(root, path), "utf8");

  it("has CodeRabbit skip every code owner, whose pull requests the independent review clears", () => {
    const config = read(".coderabbit.yaml");
    const block = /ignore_usernames:\n((?:\s+- .+\n)+)/.exec(config)?.[1] ?? "";
    const ignored = new Set(block.split("\n").map((line) => line.trim().replace(/^- /, "").toLowerCase()));
    for (const owner of parseCodeOwners(read(".github/CODEOWNERS"))) expect(ignored, owner).toContain(owner);
  });

  it("starts the workflow's job only for comments by the reviewer the policy names", () => {
    const workflow = read(".github/workflows/review-gate.yml");
    expect(workflow).toContain(`github.event.comment.user.login == '${policy.reviewer}'`);
    // Its concurrency group keeps everyone else's comments out of the reviewer's group.
    expect(workflow.replace(/\s+/g, " ")).toContain(`github.event.comment.user.login != '${policy.reviewer}'`);
  });
});

describe("review gate workflow step", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  /** Runs the script as the workflow does, against a local stand-in for GitHub's API. */
  const run = async (fixture: Fixture, eventName: string, event: unknown) => {
    const cwd = mkdtempSync(join(tmpdir(), "review-gate-"));
    directories.push(cwd);
    mkdirSync(join(cwd, ".github"));
    writeFileSync(join(cwd, ".github", "CODEOWNERS"), "* @owner-one @owner-two\n");
    writeFileSync(join(cwd, ".github", "review-gate.json"), read(".github/review-gate.json"));
    writeFileSync(join(cwd, "event.json"), JSON.stringify(event));
    const api = fakeApi(fixture);
    const authorizations: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        authorizations.push(request.headers.authorization);
        try {
          const url = request.url ?? "";
          const result =
            request.method === "POST"
              ? api.post(url, JSON.parse(body))
              : request.method === "PATCH"
                ? api.patch(url, JSON.parse(body))
                : api.get(url);
          if (result === undefined) response.writeHead(404).end("{}");
          else response.writeHead(request.method === "POST" ? 201 : 200).end(JSON.stringify(result));
        } catch {
          response.writeHead(500).end("{}");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const output: string[] = [];
      const exitCode = await new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [script], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: process.env["PATH"] ?? "",
            REVIEW_APP_TOKEN: "test-token",
            REVIEW_APP_ID: appId,
            GITHUB_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            GITHUB_SERVER_URL: "https://github.example",
            GITHUB_REPOSITORY: repo,
            GITHUB_RUN_ID: "1",
            GITHUB_EVENT_NAME: eventName,
            GITHUB_EVENT_PATH: join(cwd, "event.json"),
          },
        });
        child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));
        child.on("exit", resolve);
      });
      return { exitCode, posted: api.posted, authorizations, output: output.join("") };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  };
  const read = (path: string) => readFileSync(join(root, path), "utf8");

  it("posts CLEAR with the App token when CodeRabbit's walkthrough comment reports a clean review", async () => {
    const fixture = { pulls: [{ number: 7, author: "outside-dev", comments: [reviewer(walkthrough())] }] };
    const { exitCode, posted, authorizations, output } = await run(fixture, "issue_comment", {
      issue: { number: 7, pull_request: {} },
    });
    expect(exitCode, output).toBe(0);
    expect(posted).toEqual([
      { path: `/repos/${repo}/check-runs`, body: expect.objectContaining({ conclusion: "success", head_sha: head }) },
    ]);
    expect(new Set(authorizations)).toEqual(new Set(["Bearer test-token"]));
    const number = 7;
    expect(output).toContain(`Pull request ${number} at ${head}: clear: CLEAR from coderabbit, round 1. Posted.`);
  });

  it("posts nothing for a pull request that no longer exists, and fails on an event it doesn't handle", async () => {
    const fixture = { pulls: [{ number: 7, author: "outside-dev", comments: [reviewer(walkthrough())] }] };
    const { exitCode, posted } = await run(fixture, "issue_comment", { issue: { number: 12, pull_request: {} } });
    expect(exitCode).toBe(0);
    expect(posted).toEqual([]);
    const broken = await run(fixture, "push", {});
    expect(broken.exitCode).toBe(1);
    expect(broken.output).toContain("doesn't handle push");
  });
});
