# Contributing to Pomerado

We welcome bug reports, documentation improvements and code contributions. Start by opening a [GitHub issue](https://github.com/Pomerado/pomerado/issues/new). Discuss larger changes before you start building them.

Pomerado is agent friendly. Point your coding agent at [AGENTS.md](AGENTS.md), which has the setup, the layout and the rules it should follow. You answer for its changes as if you wrote them.

Please follow our [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately with **Report a vulnerability** on the [Security tab](https://github.com/Pomerado/pomerado/security), never in a public issue.

## Set up the repository

To use Pomerado with your agent, start with [Get started](README.md#get-started). To develop this repository, install these.

- Windows, macOS or Linux. [Native Windows](docs/windows.md) covers PowerShell setup and execution.
- Node 24.21 or a later Node 24 release.
- pnpm 10.34.5, which corepack installs for you.
- git 2.36 or later. The Linux CI scans also require Bash and jq.

Fork the repository, then clone your fork and install its dependencies.

```sh
git clone https://github.com/YOUR_USERNAME/pomerado.git
cd pomerado
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm exec playwright install chromium
corepack pnpm build
```

On Linux, add `--with-deps` after `install` if Chromium's system libraries are missing.

To try your build in an MCP client, point the client at the built entry with Node. Use absolute paths. `node -p 'process.execPath'` prints the Node path, and the server needs `OPENAI_API_KEY` in its environment to mint.

```json
{
  "mcpServers": {
    "pomerado": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/pomerado/dist/typescript/src/standalone/mcp-cli.js", "mint", "--root", "/absolute/path/to/integrations"]
    }
  }
}
```

## Find your way around

The [repository guide](README.md#repository-guide) maps the top-level folders. [How it works](docs/how-it-works.md#source-layout) lists each module under `typescript/src/`.

## Make a change

Keep changes focused and follow the conventions in [AGENTS.md](AGENTS.md). For a change in behavior, add a failing test first, make the change, then refactor. Unit tests go in `typescript/tests/unit/` and browser tests in `typescript/tests/browser/`. Tests use synthetic sites and scripted model responses, and no test may call a real model.

This package holds only code the local host runs, plus hook interfaces that other hosts implement. Update the docs when you change a public API, a tool or the CLI. Record a user-facing change under **Unreleased** in [CHANGELOG.md](CHANGELOG.md), with migration steps for a breaking change.

## Run checks

From the repository root, run these.

```sh
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
corepack pnpm test:browser
npm pack --dry-run
bash tools/ci-scan.sh content
```

Browser tests run the built `dist/`, so build before you run them. If you encounter test timeouts in resource-constrained or virtualized environments, reducing worker concurrency with `corepack pnpm test:browser --workers=2` may help. The content scan rejects a bare `#123` in files and commit messages, so link an issue there by its full URL. The [CI workflow](.github/workflows/check.yml) is the source of truth for the full set of checks, including a gitleaks secret scan.

## Open a pull request

Describe the problem, the resulting behavior and how you verified it. Link related issues, and note any checks you could not run. Keep credentials, personal data and customer data out of code, tests, commit messages and pull request text.

A maintainer approves the CI run on your pull request, then reviews it. Alan ([@alanmrsa](https://github.com/alanmrsa)) or Akshay ([@AkshayM21](https://github.com/AkshayM21)) approves every outside contributor's pull request before it merges, and the `Approval` check waits for that approval of your latest commit. Push fixes as new commits, and merge `main` into your branch rather than rebasing. Each merge publishes a canary to npm, and [Releasing](docs/RELEASING.md) covers how `latest` moves.

Contributions are made under the repository's [MIT License](LICENSE), inbound = outbound. There is no Contributor License Agreement. Third-party code keeps its own license, with its license and notice under `third-party/`.
