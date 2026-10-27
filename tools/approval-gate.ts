/**
 * Approval gate, run by .github/workflows/approval.yml. It posts the `Approval` commit status on
 * pull requests' head commits, which the ruleset on main requires from the approval GitHub App.
 *
 * - A maintainer's pull request from a branch of this repository passes. A maintainer is a user
 *   whom GitHub's API reports with write, maintain or admin permission on this repository. The
 *   payload's author association is never enough on its own, so the gate always asks the API. Only
 *   users with write access can push to this repository's branches. A fork's owner can push to its
 *   branch without that access, so a pull request from a fork needs a code owner's approval even
 *   when a maintainer opened it.
 * - Any other pull request passes only once a code owner approves its current head commit. A code
 *   owner is a user listed in .github/CODEOWNERS who also has write permission. As with dismissed
 *   stale reviews, an approval of an earlier commit stops counting after a push. A later change
 *   request or dismissal of the same reviewer's review withdraws the approval, and a later comment
 *   leaves it standing, as on GitHub. While any reviewer with write permission has changes
 *   requested as their latest verdict, the pull request fails, as GitHub's required reviews do.
 *
 * Every user CODEOWNERS lists counts as an owner of every path, which is what the file assigns.
 * Team entries are skipped, since the gate's token has no organization permissions.
 *
 * A status belongs to a commit, not a pull request, and several open pull requests can share a head
 * commit. The gate evaluates every open pull request at the commit and posts success when any of
 * them passes, since each would merge the same code. So opening another pull request at a commit
 * can't take away the status a maintainer's pull request earned there.
 *
 * The workflow runs this file from the default branch, never from a pull request. It reads each fact
 * from GitHub's API, so nothing a pull request contains or sends decides the result.
 *
 * Usage, in the workflow: node tools/approval-gate.ts
 */
import { appendFileSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

/** The status context the ruleset requires. */
export const statusContext = "Approval";

const writeRoles = new Set(["admin", "maintain", "write"]);
/** Review states that set a reviewer's verdict. A comment review doesn't change it. */
const verdictStates = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

export interface GitHub {
  /** One REST resource, or undefined when GitHub answers 404. */
  readonly get: (path: string) => Promise<unknown>;
  /** Every item of a paginated REST list. */
  readonly list: (path: string) => Promise<readonly unknown[]>;
}

export interface Verdict {
  readonly state: "success" | "failure";
  /** The status description, at most 140 characters. */
  readonly description: string;
}

interface PullRequest {
  readonly number: number;
  readonly user: { readonly login: string };
  /** `repo` is null once the head branch's fork is deleted. */
  readonly head: { readonly sha: string; readonly repo: { readonly full_name: string } | null };
}

interface Review {
  readonly user: { readonly login: string } | null;
  readonly state: string;
  readonly commit_id: string | null;
}

/** The lowercased user names CODEOWNERS lists. Teams and email addresses are skipped. */
export const parseCodeOwners = (text: string): string[] => {
  const owners = new Set<string>();
  for (const line of text.split("\n")) {
    const [, ...entries] = line.replace(/#.*/, "").trim().split(/\s+/);
    for (const entry of entries) if (/^@[\w-]+$/.test(entry)) owners.add(entry.slice(1).toLowerCase());
  }
  return [...owners];
};

const canWrite = async (github: GitHub, repo: string, login: string): Promise<boolean> => {
  const body = (await github.get(`/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`)) as
    | { readonly permission?: string }
    | undefined;
  return body?.permission !== undefined && writeRoles.has(body.permission);
};

/** Decides the `Approval` status of one pull request at `sha`, the head commit it is checked for. */
export const evaluate = async (
  github: GitHub,
  repo: string,
  pull: PullRequest,
  sha: string,
  codeOwners: readonly string[],
): Promise<Verdict> => {
  const sameRepository = pull.head.repo?.full_name.toLowerCase() === repo.toLowerCase();
  if (sameRepository && (await canWrite(github, repo, pull.user.login))) {
    return { state: "success", description: "The author has write access, so no code owner approval is needed." };
  }
  // GitHub lists reviews oldest first, so the last verdict per reviewer is the one that stands.
  const latest = new Map<string, Review & { readonly user: { readonly login: string } }>();
  for (const review of (await github.list(`/repos/${repo}/pulls/${pull.number}/reviews`)) as Review[]) {
    if (review.user !== null && verdictStates.has(review.state)) {
      latest.set(review.user.login.toLowerCase(), { ...review, user: review.user });
    }
  }
  const owners = new Set(codeOwners);
  let approver: string | undefined;
  let staleApproval = false;
  for (const [login, review] of latest) {
    if (review.state === "DISMISSED") continue;
    if (review.state === "APPROVED" && !owners.has(login)) continue;
    if (!(await canWrite(github, repo, review.user.login))) continue;
    if (review.state === "CHANGES_REQUESTED") {
      return { state: "failure", description: `@${review.user.login} requested changes.` };
    }
    if (review.commit_id === sha) approver ??= review.user.login;
    else staleApproval = true;
  }
  if (approver !== undefined) {
    return { state: "success", description: `Code owner @${approver} approved the head commit.` };
  }
  const description = staleApproval
    ? "A code owner approved an earlier commit. The head commit needs a code owner's approval."
    : sameRepository
      ? "The author lacks write access, so the head commit needs a code owner's approval."
      : "The pull request comes from a fork, so the head commit needs a code owner's approval.";
  return { state: "failure", description };
};

/**
 * Decides the status of `sha` from the open pull requests whose head it is. It is undefined when
 * no open pull request is at `sha` any longer: each push is evaluated at its own head.
 */
export const evaluateCommit = async (
  github: GitHub,
  repo: string,
  sha: string,
  codeOwners: readonly string[],
): Promise<(Verdict & { readonly pulls: readonly number[] }) | undefined> => {
  const open = (await github.list(`/repos/${repo}/pulls?state=open`)) as PullRequest[];
  const pulls = open.filter((pull) => pull.head.sha === sha);
  let failure: Verdict | undefined;
  for (const pull of pulls) {
    const verdict = await evaluate(github, repo, pull, sha, codeOwners);
    if (verdict.state === "success") return { ...verdict, pulls: [pull.number] };
    failure ??= verdict;
  }
  return failure === undefined ? undefined : { ...failure, pulls: pulls.map((pull) => pull.number) };
};

/** The head commits an event asks the gate to evaluate. */
export const commitsToEvaluate = async (
  github: GitHub,
  repo: string,
  eventName: string,
  event: unknown,
): Promise<string[]> => {
  // The event's commit only points at what to evaluate. The verdict comes from the API.
  if (eventName === "pull_request_target") {
    return [(event as { readonly pull_request: PullRequest }).pull_request.head.sha];
  }
  // A submitted or dismissed review woke the gate. The review's run names the head commit it ran for.
  if (eventName === "workflow_run") {
    return [(event as { readonly workflow_run: { readonly head_sha: string } }).workflow_run.head_sha];
  }
  // A maintainer's dispatch evaluates every open pull request again.
  if (eventName === "workflow_dispatch") {
    const open = (await github.list(`/repos/${repo}/pulls?state=open`)) as PullRequest[];
    return [...new Set(open.map((pull) => pull.head.sha))];
  }
  throw new Error(`The approval gate doesn't handle ${eventName} events.`);
};

export interface ClientOptions {
  /** Requests per call, counting the first. Failures GitHub may recover from are tried again. */
  readonly attempts?: number;
  readonly wait?: (milliseconds: number) => Promise<unknown>;
}

/** GitHub's REST API. It retries network errors, 5xx, 429 and rate limit answers, with backoff. */
export const createClient = (token: string, api: string, options: ClientOptions = {}) => {
  const attempts = options.attempts ?? 4;
  const wait = options.wait ?? delay;
  const request = async (method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<unknown> => {
    for (let attempt = 1; ; attempt += 1) {
      let problem: string;
      try {
        const response = await fetch(`${api}${path}`, {
          method,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-github-api-version": "2022-11-28",
          },
          body: body === undefined ? null : JSON.stringify(body),
        });
        if (method === "GET" && response.status === 404) return undefined;
        if (response.ok) return (await response.json()) as unknown;
        problem = `${method} ${path} answered ${response.status}: ${await response.text()}`;
        const rateLimited = response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0";
        if (response.status < 500 && response.status !== 429 && !rateLimited) throw new Error(problem);
      } catch (error) {
        // fetch throws a TypeError when the request never got an answer.
        if (!(error instanceof TypeError)) throw error;
        problem = `${method} ${path} failed: ${error.message}`;
      }
      if (attempt >= attempts) throw new Error(`${problem} (after ${attempt} attempts)`);
      await wait(1000 * 4 ** (attempt - 1));
    }
  };
  return {
    get: (path: string) => request("GET", path),
    list: async (path: string) => {
      const items: unknown[] = [];
      for (let page = 1; ; page += 1) {
        const batch = (await request("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`)) as
          | unknown[]
          | undefined;
        items.push(...(batch ?? []));
        if (batch === undefined || batch.length < 100) return items;
      }
    },
    post: (path: string, body: unknown) => request("POST", path, body),
    patch: (path: string, body: unknown) => request("PATCH", path, body),
  };
};

const main = async (): Promise<void> => {
  const env = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set.`);
    return value;
  };
  const repo = env("GITHUB_REPOSITORY");
  const github = createClient(env("APPROVAL_APP_TOKEN"), env("GITHUB_API_URL"));
  const event = JSON.parse(readFileSync(env("GITHUB_EVENT_PATH"), "utf8")) as unknown;
  const codeOwners = parseCodeOwners(readFileSync(".github/CODEOWNERS", "utf8"));
  const targetUrl = `${env("GITHUB_SERVER_URL")}/${repo}/actions/runs/${env("GITHUB_RUN_ID")}`;
  for (const sha of await commitsToEvaluate(github, repo, env("GITHUB_EVENT_NAME"), event)) {
    const verdict = await evaluateCommit(github, repo, sha, codeOwners);
    if (verdict === undefined) {
      console.log(`No open pull request is at ${sha} any longer.`);
      continue;
    }
    await github.post(`/repos/${repo}/statuses/${sha}`, {
      state: verdict.state,
      context: statusContext,
      description: verdict.description,
      target_url: targetUrl,
    });
    const line = `${sha} (pull request ${verdict.pulls.join(", ")}): ${verdict.state}. ${verdict.description}`;
    console.log(line);
    const summary = process.env["GITHUB_STEP_SUMMARY"];
    if (summary) appendFileSync(summary, `${line}\n`);
  }
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
