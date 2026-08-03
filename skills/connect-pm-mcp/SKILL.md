# Connect PM via MCP — Skill

Walk the user through connecting their **PM workspace** to their AI client over MCP, so the AI can read their projects, tasks, Client Requests, comments, and search results on demand. The mechanism is the published npm package [`trlabs-pm-mcp`](https://www.npmjs.com/package/trlabs-pm-mcp): a local stdio MCP server that calls the user's PM instance with a personal access token.

This skill is **client-agnostic onboarding** — it figures out which AI client the user runs, helps them mint a token, hands them the exact config, and verifies it. It does not install or build anything; the server runs via `npx -y trlabs-pm-mcp` (zero clone, zero build).

## When to invoke

Load this file when the user says any of:
- `connect my pm` / `connect pm` / `connect pm to mcp`
- `set up pm mcp` / `add pm mcp` / `pm mcp`
- `let claude read my pm` / `let my ai read pm` / `read my pm`
- `set up pm access` / `connect my project tracker`

If the trigger is ambiguous (e.g. the user is mid-discussion about PM rather than asking to wire it up), confirm once: "Want me to walk you through connecting your PM to your AI client over MCP?" before running the protocol.

## What the user needs (prerequisites)

1. **A PM account** — on the hosted instance at `https://pm.trlabs.my` (open registration) or on their own self-hosted deployment. If they don't have one, point them to sign up first.
2. **Node 18+** locally (so `npx` works).
3. **A personal access token** — minted in PM (this skill walks them through it).

## Protocol

### 1. Identify the AI client

Ask which client they want to connect (this determines the config format). Use `AskUserQuestion` with these options:
- **Claude Code** (CLI)
- **Claude Desktop**
- **Cursor**
- **Other** (Codex CLI / Gemini CLI / other MCP client)

### 2. Mint a PM token

Tell the user:
> Go to **`https://pm.trlabs.my/settings/api-tokens`** (Settings → API access in the sidebar), click **Create token**, give it a name (e.g. "Claude on my laptop"), and **copy the `pmk_…` value — it's shown only once.** If you self-host PM, use your own URL's `/settings/api-tokens`.

If they're self-hosting, also capture their PM base URL (e.g. `https://pm.mycompany.com`) — it goes in `PM_BASE_URL`. Default is `https://pm.trlabs.my`.

Do **not** ask them to paste the token into the chat — it goes straight into their client config. If they do paste it, treat it as sensitive: don't echo it back, and suggest they rotate it.

### 3. Hand them the config for their client

Give the exact snippet. Default `PM_BASE_URL` is `https://pm.trlabs.my`; include it explicitly only if they self-host.

**Claude Code** — one command:
```bash
claude mcp add --transport stdio --env PM_TOKEN=pmk_THEIR_TOKEN --scope user trlabs-pm -- npx -y trlabs-pm-mcp
```
- `--scope user` = available in all their projects. `--scope local` (drop the flag) = current project only.
- Self-host: add `--env PM_BASE_URL=https://their-instance`.
- They can instead keep the token in their shell env and use `${PM_TOKEN}` expansion in `.mcp.json` / `~/.claude.json`.

**Claude Desktop** — edit `claude_desktop_config.json` (macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`), then restart the app:
```json
{
  "mcpServers": {
    "trlabs-pm": {
      "command": "npx",
      "args": ["-y", "trlabs-pm-mcp"],
      "env": { "PM_TOKEN": "pmk_THEIR_TOKEN" }
    }
  }
}
```

**Cursor** — edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project): same `mcpServers` JSON shape as Claude Desktop.

**Codex CLI** — edit `~/.codex/config.toml`:
```toml
[mcp_servers.trlabs-pm]
command = "npx"
args = ["-y", "trlabs-pm-mcp"]
env = { PM_TOKEN = "pmk_THEIR_TOKEN" }
```

**Gemini CLI** — edit `~/.gemini/settings.json`: same `mcpServers` JSON shape as Claude Desktop.

For any client, add `"PM_BASE_URL": "https://their-instance"` to `env` if self-hosting.

### 4. Verify

- **Claude Code**: `claude mcp list` (look for `trlabs-pm` connected) or `/mcp` inside a session.
- **Desktop / Cursor / Gemini**: restart the app, then check the MCP/tools panel for `trlabs-pm` and its tools (`list_projects`, `list_tasks`, `read_cr`, `search`, …).
- Then have them try it: *"list my PM projects"* (exercises `list_projects`) or *"read CR &lt;requestId&gt;"*.

### 5. Show what they can ask

As of `0.2.0` the server exposes **8 read tools** (the AI calls them automatically):
- **`list_projects`** — every project they can see + CR/task counts (the name → id resolver; start here)
- **`list_tasks`** / **`read_task`** — a project's tasks (filter by `status`/`assignee`/`category`/`phase`) + one task's full detail (checklist, comments, source CR)
- **`list_categories`** — a project's task categories
- **`read_cr`** — one CR (`requestId`) or a project's CRs (`projectId`), now filterable by `status`/`phase`/`categoryId` + `limit`/`offset`
- **`read_comments`** — comments on a CR or task (`targetType: cr|task`)
- **`search`** — substring search across visible projects (CRs + tasks)
- **`whoami`** — their identity + how many projects they can see

**Write tools (`0.3.0`–`0.4.0`, require a `readwrite`-scoped token):** `create_cr`, `update_task_status`, `add_checklist_items`, `set_checklist_item` (toggle ONE subtask done/undone — added `0.4.0`), and `revert_write` (undo a prior write via the `undo` token it returned). All carry `destructiveHint` — the AI should propose the exact change and get approval before calling. (As of `0.4.0` the task-id tools also accept a human task code like `PROJ-42`, not just the UUID.) Mint a `readwrite` token via the **Read + write** option in the scope toggle at `/settings/api-tokens`; the default **Read only** can't write (403).

Examples to suggest:
- "List my PM projects." → `list_projects`
- "What tasks are still open in <project>?" → `list_tasks` (status filter)
- "Search PM for anything about PDFs."
- "Read CR &lt;requestId&gt;."

## What this skill does NOT do

- It does **not** handle the user's token for them or store it — the token lives only in their client config.
- It does **not** install/build the package — `npx -y trlabs-pm-mcp` fetches and runs it on demand.
- Write tools (`0.3.0`) exist but require an explicitly `readwrite`-scoped token (default is read-only); they're `destructiveHint`-annotated so clients prompt before running. CR *decisions* (approve/reject) are NOT exposed — those are done manually in the PM UI.
- It is **not** a Mavis-brain write — connecting PM is the user's local config, not project work; no daily-memory / progress entry.

## Edge cases

- **No PM account** → direct them to register at `pm.trlabs.my` (or stand up their own instance) before continuing.
- **Self-hosted PM** → capture their base URL and add `PM_BASE_URL` to every config snippet.
- **`npx` not found (Windows)** → Node.js isn't installed or not on `PATH`; have them install Node 18+.
- **Tool shows but every call errors "invalid or missing token"** → token wrong/revoked; mint a fresh one and update the config.
- **"PM API unreachable"** → wrong `PM_BASE_URL` or the instance is down.
- **Package not found on npm** → the package may not be published yet for this audience; if the user is the maintainer working pre-publish, point them at the local build (`node <abs path>/dist/server.js`) instead of `npx`. (As of 2026-06-03 it IS published: `trlabs-pm-mcp@0.3.0` — 8 read + 4 write/revert tools.)
- **Tool doesn't appear in the CURRENT session after adding** → a newly-added MCP server only loads when the client **restarts**. `claude mcp list` may show `✓ Connected` (a live health check) while the running session still lacks the `read_cr` tool. Tell the user to start a fresh session.
- **"List CRs for &lt;project name&gt;" but you need an id** → use **`list_projects`** (shipped `0.2.0`) to resolve name → `projectId`, then `read_cr`/`list_tasks`. Clients still on `0.1.0` lack that resolver — have the user read the id out of the PM URL when the project is open, and keep the name→id pairs in that project's `notes.md` so the lookup only happens once.

## Notes for the maintainer

- The canonical, always-current per-client config lives in the package's own `README.md` (sibling repo `trlabs-pm-mcp`). Keep this skill's snippets in sync with it when the package changes.
- This skill only "works" for other people once `trlabs-pm-mcp` is **published to npm** — that's the unlock that makes `npx -y trlabs-pm-mcp` resolve for anyone. Until then it's usable via a local build path.
