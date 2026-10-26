# AGENTS.md

Guidance for coding agents that change this repository. These rules add to [CONTRIBUTING.md](CONTRIBUTING.md), which covers the same setup and review process for people. To install Pomerado for a user, follow [docs/agent-setup.md](docs/agent-setup.md) instead.

## Setup and checks

Use Windows, macOS or Linux, Node 24.21 or a later Node 24 release, and git 2.36 or later.
See [Native Windows](docs/windows.md). Bash and jq are needed for the Linux CI scans only.

```sh
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
corepack pnpm exec playwright install chromium
corepack pnpm test:browser
npm pack --dry-run
bash tools/ci-scan.sh content
GITLEAKS=/path/to/gitleaks bash tools/ci-scan.sh secrets
```

- Browser tests run the built `dist/`, so build before you run them.
- Tests use synthetic sites and scripted model responses. They need no model key, and no test may call a real model.
- CI runs gitleaks 8.30.1.
- Set `EVENT=pull_request`, `PR_BASE` to the base commit and `PR_HEAD` to your head commit to scan your commits as CI does. The content scan then also checks your commit messages, and the secrets scan checks each commit's diff.

## Layout

- `typescript/src/` holds the minter, Guardian, the runtime, browser helpers and the local MCP host.
- `typescript/authoring/` holds the minter's shared prompts and examples.
- `typescript/tests/unit/` holds Vitest tests, and `typescript/tests/browser/` holds Playwright tests with local fixture sites.
- `tools/` holds build helpers and the CI scans.
- `docs/` holds guides. [docs/how-it-works.md](docs/how-it-works.md) lists each module.
- In code, OpenAI model IDs are set only in `typescript/src/models/models.ts`. A unit test enforces it.

## Rules

- Every change goes through a pull request. Never push to `main`.
- Never run `gh pr merge`. A maintainer merges.
- Bring `main` into your branch with a merge, not a rebase. Never force-push.
- A pull request merges only after an independent review and green CI.
- Rulesets on `main` enforce this. They require a pull request and three checks on the current head: a green `CI`, `review/clear` from the independent review, and `Approval`. The approval gate in `.github/workflows/approval.yml` posts `Approval` through its own GitHub App. It passes at once when the author is a maintainer, someone with write access, and the head branch is in this repository. A pull request from a fork, or from an outside contributor, also needs a code owner's approval of its current head commit before `Approval` passes. [docs/RELEASING.md](docs/RELEASING.md#the-approval-gate) describes the gate and its setup. The release workflow runs the full check again on every push to `main`, which validates the merged result.
- Maintainers merge by hand with a merge commit until a merge queue takes over.
- A push after a review needs a new independent review.
- Write the failing test first for a change in behavior.
- Add to this package only code the local host runs, or a hook interface another host implements.
- Keep `#N` style references out of commit messages, where N is a number. The content scan rejects them. Link a public issue by its full URL.
- Public text stays generic. Keep customer data, credentials, incidents, internal hostnames and internal references out of code, tests, commit messages and pull request text.
- Third-party code keeps its own license. Put its license and notice under `third-party/`, as `third-party/codex/` does for the Guardian policy, and ship them with the package.
- Contributions are accepted under the MIT License.
