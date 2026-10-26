# Native Windows

Windows runs the local minter and generated integrations directly, without WSL, Git Bash,
administrator privileges or Developer Mode. Use a source build containing the Windows changes;
an older npm release still rejects Windows even if its `--help` command works.

## Build and check

Install Git for Windows and Node 24.21 or a later Node 24 release (below Node 25), with Corepack available.
Browser TLS fixtures use the OpenSSL included with Git for Windows; the test configuration
finds it automatically. The runtime itself does not require OpenSSL's command-line program.
From PowerShell in this checkout:

```powershell
node --version
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm build
corepack pnpm exec playwright install chromium
corepack pnpm test
corepack pnpm test:browser --workers=2
npm pack --dry-run
```

The build uses Node filesystem operations, so Unix shell utilities are unnecessary. The
repository's Bash CI scanner tests run on Linux; Windows runs the portable scan tests and
tests real directory permission failures using ACLs. Linux procfs and privileged file-symlink
fixtures remain platform-specific. Windows junction refusal is tested without elevation.

## Start the MCP server

Use absolute paths to the Node executable, built entry and integration output folder. For
example, a client that reads `mcpServers` can use:

```json
{
  "mcpServers": {
    "pomerado": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\tools\\pomerado\\dist\\typescript\\src\\standalone\\mcp-cli.js",
        "mint", "--root", "C:\\tools\\pomerado-integrations"
      ]
    }
  }
}
```

Replace the example paths with yours. `node -p process.execPath` prints the actual Node path.
The entry starts a native executable directly, so no batch-file or shell quoting is involved.
Follow [client settings](getting-started.md#client-settings) to pass `OPENAI_API_KEY` by name;
do not paste its value into chat or a committed configuration. Discovery needs no key.

After a mint publishes, the generated `mcp.json` already names the correct Node executable
and runtime. Add that integration as its own server. Its README's add commands use PowerShell
quoting on Windows. Running it needs no model key. Keep the Pomerado installation at the same
path, or update the generated configuration when moving it.

## Execution behavior

- Offline `exec_command` uses `cmd.exe /d /s /c` by default; `login` has no effect on that shell.
  Use Node for portable offline file processing, or explicitly select a shell you installed.
  The default environment includes only the Node and Windows system command paths and
  `SystemRoot`. Explicit workspace environment values can override them. Provider keys are
  not inherited by authored commands.
  The separate native browser worker receives only its Windows temporary-directory path.
  Native browser cleanup allows 15 seconds per resource by default on Windows; callers can
  set `cleanupTimeoutMs` explicitly. A cleanup that cannot be confirmed still fails.
- Each child joins its own Windows Job Object before authored code or a command can run.
  Cancellation, timeouts and host exit terminate its process tree, including descendants whose
  immediate parent exited. Other applications are outside that job. Failure to establish the
  job stops execution.
- Guardian's bounded source reader holds ancestor handles without delete sharing and refuses
  reparse points, alternate streams, device names and ambiguous Windows path suffixes. A
  concurrent rename may fail while a source read holds those handles.
- Runtime staging uses directory junctions and module re-exports instead of privileged file
  symlinks. The re-exports preserve the identity of the running SDK's error classes.
- Authoring sections, reference text and Guardian policy bodies normalize CRLF to LF, keeping
  prompt content consistent across checkouts.

The Windows native calls use the pinned Koffi dependency's prebuilt binary. No C++ compiler
is needed on its supported Windows architectures. Windows CI exercises the full unit and
Chromium suites. The local host still runs with your user account's filesystem and network
permissions; a Job Object provides cleanup, not a security sandbox.

Saved logins, automatic maintenance and protected answer collection remain hosted features.
Passwords and other answers sent through MCP remain visible to the client and its model
provider. Native Windows support does not establish compatibility with a particular website;
prove its sign-in and operation against that site separately.
