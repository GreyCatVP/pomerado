# Set up Pomerado for your user

These steps are for an AI agent that installs Pomerado for the person it works with. Pomerado is a local MCP server that builds MCP integrations for websites. Follow the steps in order, and stop where a step says to ask.

Follow these rules throughout.

- Never ask for the user's OpenAI API key in chat.
- Never read, print, echo, test or log the key, and never write its value into a file.
- Ask before you install software the user didn't mention, such as Node.
- Ask before you change user-level or global configuration the user didn't mention.
- Tell the user what you changed when you finish.

## 1. Check the platform and Node

On Windows, use the [native Windows source-build guide](windows.md) and PowerShell. Check
`node --version` and the actual Node executable with `node -p process.execPath`. Use the
built `mcp-cli.js` with that executable when configuring the client; older published releases
do not include Windows support. Keep the permission and key-handling rules above. The
commands below describe the published macOS/Linux installation route.

```sh
uname -s
node --version
```

- Continue on macOS, where `uname -s` prints `Darwin`, or on Linux.
- On Windows, follow the source-build guide linked above. Stop on any other platform.
- Continue if Node prints `v24.21.0` or a later `v24` release.
- Otherwise stop and ask. Tell the user Pomerado needs Node 24.21 or a later Node 24 release, and ask how they want to install it. Don't install or switch Node without their answer.

## 2. Install Pomerado and Chromium

```sh
npx -y -p pomerado pomerado-mcp --help
npx -y -p pomerado playwright install chromium
```

- The first command must print `Pomerado MCP` and its usage. If it prints nothing, npm's cache holds a version older than 0.2.0. Run it again with `pomerado@latest` in place of `pomerado`, and use that spelling in every later step.
- The second command installs the Chromium build Pomerado expects. Playwright may warn about project dependencies. The browser installs anyway.
- On Linux, Chromium may need system libraries. Ask the user before you run `npx -y -p pomerado playwright install --with-deps chromium`, because it uses `sudo`.

## 3. Choose the folder and the scope

- Ask where Pomerado should save integrations, unless the user said. Suggest `~/pomerado-integrations`. Use the absolute path from here on.
- Ask whether Pomerado should be available in every project or only the current one, unless the user said.

## 4. Add the server to your client

Use the section for the client you run in. Ask the user if you aren't sure which client that is. [Client settings](getting-started.md#client-settings) has the details and the source for each client.

### Claude Code

```sh
claude mcp add --scope user pomerado -- npx -y -p pomerado pomerado-mcp mint --root /absolute/path/to/pomerado-integrations
```

- `--scope user` adds Pomerado for every project. `--scope project` writes `.mcp.json` in the current project instead.
- Claude Code asks the user to approve a project server before it starts it.
- Claude Code passes its own environment to the server, so the key needs no config line.

### Codex

```sh
codex mcp add pomerado -- npx -y -p pomerado pomerado-mcp mint --root /absolute/path/to/pomerado-integrations
```

- Ask the user before you run it. `codex mcp add` writes the global `~/.codex/config.toml`, or `$CODEX_HOME/config.toml`, so the server appears in every project.
- For one project only, add the same section to `.codex/config.toml` in that project instead. Codex reads it only in a trusted project.
- Then add `env_vars = ["OPENAI_API_KEY"]` and `startup_timeout_sec = 60` to the `[mcp_servers.pomerado]` section. These lines name the variable and hold no key.

### Gemini CLI

```sh
gemini mcp add -s user -e 'OPENAI_API_KEY=$OPENAI_API_KEY' pomerado npx -y -p pomerado pomerado-mcp mint --root /absolute/path/to/pomerado-integrations
```

- `-s user` adds Pomerado for every project. `-s project` adds it to the current project instead.
- Keep the single quotes. The settings file then stores a reference to the variable and not the key.

### Cursor, VS Code and Claude Desktop

Add this entry to the client's `mcpServers` file, in the place [Client settings](getting-started.md#client-settings) names for that client.

```json
{
  "mcpServers": {
    "pomerado": {
      "command": "npx",
      "args": ["-y", "-p", "pomerado", "pomerado-mcp", "mint", "--root", "/absolute/path/to/pomerado-integrations"]
    }
  }
}
```

## 5. Ask the user to provide the key

- Tell the user the server needs `OPENAI_API_KEY` in its environment, and that Pomerado calls OpenAI models to build and review integrations.
- Ask the user to set the key themselves, in their shell profile or the client's own key setting. Point them to their client in [Client settings](getting-started.md#client-settings).
- Tell the user not to paste the key into chat.
- Claude Desktop documents no way to reference a variable. Tell the user the key would sit as plain text in the entry's `env` block. If they accept that, they add the key to the `env` block themselves.

## 6. Verify

- Run your client's list command, such as `claude mcp list` or `gemini mcp list`. It should show `pomerado` as connected. `codex mcp list` shows only the configuration.
- Most clients load a new server in a new session. Ask the user to restart or reload the client if you can't see Pomerado's tools yet.
- Check that you have the four tools `mint`, `get_job`, `provide_input` and `cancel_job`. Listing them needs no key and launches no browser.

## 7. Suggest a first integration

Suggest this prompt, and wait for the user to agree before you run it. Minting calls paid models on the user's OpenAI account.

> Use Pomerado to create an integration named example_reader that reads the main heading from https://example.com. Keep it read-only.

- Choose `read` authority unless the user asks for a change on the website.
- Follow the job with `get_job` until it finishes. Never call `mint` again for the same job.
- Before you collect a password or code, tell the user that answers sent through `provide_input` are visible to the MCP client and its model provider.
- When the mint finishes, open the integration's `README.md` and add the integration with the command for your client, after asking the user. The integration needs no model key, so leave out `env_vars`, the Gemini `-e` flag and step 5.
