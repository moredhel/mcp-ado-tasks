# ado-tasks-mcp

An [MCP](https://modelcontextprotocol.io) server that gives Claude Code persistent, auditable task tracking via **Azure DevOps Work Items**.

Claude's built-in task tools vanish at the end of a session. This server replaces them with ADO Tasks so work is tracked across sessions and visible to your whole team.

---

## How it works

```
User Story  ← you hand Claude this ID
  └── Task  ← Claude creates these as child work items
  └── Task  ← with dependency links between them
```

At the start of a session Claude calls `set_story` with your User Story ID. It then creates, links, and updates ADO Task work items as it works — instead of in-memory todos that disappear.

---

## Prerequisites

- Python 3.10+
- An Azure DevOps organisation with a project
- A Personal Access Token (PAT) with **Work Items (Read & Write)** scope

---

## Installation

```bash
pip install mcp
```

Then register the server with Claude Code at user scope (available in every repo):

```bash
claude mcp add --scope user tasks -- python3 /path/to/server.py
```

Set these environment variables (e.g. in your shell profile):

```bash
export ADO_PAT="your-pat-here"
export ADO_ORG="your-org"
export ADO_PROJECT="your-project"
```

---

## Deploy to Cloudflare Workers (with API key auth)

This repo includes a Worker implementation at `cloudflare/src/worker.js` that exposes the same MCP tools over HTTP at `/mcp`.

1. Install Wrangler:

```bash
npm install -g wrangler
```

2. Configure and deploy:

```bash
cd cloudflare
wrangler secret put ADO_PAT
wrangler secret put MCP_API_KEY
wrangler deploy
```

Set `ADO_ORG` and `ADO_PROJECT` in `cloudflare/wrangler.toml` under `[vars]` (or as Worker environment variables).

3. (Optional, recommended) persist session state in KV:

```bash
cd cloudflare
wrangler kv namespace create SESSION_KV
```

Then add this to `cloudflare/wrangler.toml` with your namespace ID:

```toml
[[kv_namespaces]]
binding = "SESSION_KV"
id = "<your-kv-namespace-id>"
```

4. Call the MCP endpoint with an API key:

```bash
curl https://<your-worker>.workers.dev/mcp \
  -H "content-type: application/json" \
  -H "x-api-key: <your-api-key>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The Worker accepts either:
- `x-api-key: <MCP_API_KEY>`
- `Authorization: Bearer <MCP_API_KEY>`

> If you skip KV binding, session state falls back to in-memory storage and can reset between Worker isolates.

### GitHub Actions CI/CD deployment

This repo includes `.github/workflows/deploy-cloudflare-worker.yml` to deploy on pushes to `main` (for `cloudflare/**` changes) and via manual dispatch.

Configure these repository **secrets** before enabling the workflow:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `ADO_PAT`
- `MCP_API_KEY`
- `ADO_ORG`
- `ADO_PROJECT`

---

## CLAUDE.md snippet

Add this to your project's `CLAUDE.md` (or `~/.claude/CLAUDE.md` for all projects) so Claude knows to use the ADO tools:

```markdown
## Task Management

This project tracks tasks in Azure DevOps. Always use the MCP task tools, never the built-in TaskCreate/TaskUpdate/TaskList/TaskGet tools.

At the start of each work session:
1. The user will provide a User Story ID (e.g. "#4321")
2. Call `mcp__tasks__set_story(story_id="4321")` to set the context — this automatically moves the story to Active
3. Confirm the story title back to the user before proceeding

At the end of each work session (when implementation is complete):
- Call `mcp__tasks__story_resolve` to move the story to Resolved

When breaking down work:
- Create one ADO Task per logical unit of work via `mcp__tasks__task_create`
- Wire up dependencies with `mcp__tasks__task_link` before starting work
- Update task status via `mcp__tasks__task_update` as work progresses
- Use `mcp__tasks__task_list` instead of TaskList
- Use `mcp__tasks__task_get` instead of TaskGet
- Use `mcp__tasks__task_list_mine` to see all tasks assigned to you across the project

Do NOT use: TaskCreate, TaskUpdate, TaskList, TaskGet, TaskDelete — use the ADO MCP equivalents above.
```

---

## Available tools

| Tool | Description |
|------|-------------|
| `set_story` | Set the active User Story for the session. Auto-transitions it to **Active**. |
| `task_create` | Create an ADO Task as a child of the active story. |
| `task_update` | Update state, title, description, or assignee on a Task. |
| `task_list` | List all Tasks under the active story. |
| `task_get` | Get full details of a single Task, including relations. |
| `task_link` | Create a predecessor/successor dependency link between two Tasks. |
| `task_list_mine` | List all Tasks assigned to you (`@Me`) across the project. |
| `story_resolve` | Mark the active User Story as **Resolved**. |

### State mapping

| Claude status | ADO state |
|---------------|-----------|
| `pending` | To Do |
| `in_progress` | Active |
| `completed` | Closed |
| `deleted` | Removed |

---

## Session state

The active story ID is persisted to `~/.local/share/life-manager/session.json` so it survives MCP server restarts within a session.

---

## License

MIT
