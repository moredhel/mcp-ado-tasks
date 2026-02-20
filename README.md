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

- Node.js 18+
- An Azure DevOps organisation with a project
- A Personal Access Token (PAT) with **Work Items (Read & Write)** scope

---

## Deploy to Cloudflare Workers (with API key auth)

This repo includes a Worker implementation at `cloudflare/src/worker.js` that exposes MCP tools over HTTP at `/mcp`.

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

### Rate Limiting

The Worker implements rate limiting at **10 requests per second per source IP address**. When the limit is exceeded, the server returns a `429 Too Many Requests` response with a `Retry-After` header.

Rate limiting uses KV storage for persistence:
- If `RATE_LIMIT_KV` is configured, it's used for rate limiting counters
- Otherwise, falls back to `SESSION_KV` if available
- Final fallback is in-memory storage (may reset between Worker isolates)

To configure a dedicated rate limiting KV namespace:

```bash
cd cloudflare
wrangler kv namespace create RATE_LIMIT_KV
```

Then add to `cloudflare/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "<your-kv-namespace-id>"
```

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

## Task Management Guidelines

This repository includes a `CLAUDE.md` file that provides guidelines for Claude on how to use the ADO task management tools. The file is automatically picked up by Claude when working in this repository.

Key points:
- Always use the MCP task tools (`mcp__tasks__*`) instead of built-in task tools
- Call `set_story` at the start of each session with the User Story ID
- Call `story_resolve` when implementation work is complete
- Create tasks via `task_create`, update via `task_update`, list via `task_list` and `task_list_mine`

See `CLAUDE.md` for complete details.

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

When using Cloudflare Workers with KV namespace binding, the active story ID is persisted in KV storage. Without KV, session state falls back to in-memory storage and may reset between Worker isolates.

---

## License

MIT
