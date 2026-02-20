# GitHub Copilot Instructions for ado-tasks-mcp

## Overview

This is an MCP (Model Context Protocol) server that provides Claude Code with persistent, auditable task tracking via Azure DevOps Work Items. It replaces Claude's built-in ephemeral task tools with ADO Tasks that persist across sessions.

## Project Structure

- `cloudflare/src/worker.js` - Cloudflare Worker implementation exposing MCP tools over HTTP
- `cloudflare/wrangler.toml` - Worker configuration (sets ADO_ORG and ADO_PROJECT)
- `.github/workflows/deploy-cloudflare-worker.yml` - CI/CD workflow for deploying to Cloudflare
- `CLAUDE.md` - Task management guidelines for Claude agents
- `README.md` - Main documentation

## Technology Stack

- **Runtime**: Cloudflare Workers (V8 JavaScript runtime with Node.js API compatibility)
- **Protocol**: MCP (Model Context Protocol)
- **External API**: Azure DevOps REST API
- **Storage**: Cloudflare KV (optional, for session persistence)

## Task Management

**IMPORTANT**: This project uses Azure DevOps for task tracking. When working on issues:

1. At the start of each session:
   - The user will provide a User Story ID (e.g. "#4321")
   - Call `mcp__tasks__set_story(story_id="4321")` to set context
   - This automatically moves the story to Active state

2. When breaking down work:
   - Create ADO Tasks via `mcp__tasks__task_create`
   - Wire dependencies with `mcp__tasks__task_link`
   - Update status via `mcp__tasks__task_update` as work progresses

3. At the end of implementation:
   - Call `mcp__tasks__story_resolve` to mark the story as Resolved

**Never use** the built-in TaskCreate/TaskUpdate/TaskList/TaskGet tools - use the ADO MCP equivalents instead.

## Build and Validation

### JavaScript Validation
```bash
node --check cloudflare/src/worker.js
```

### Deployment
```bash
cd cloudflare
wrangler secret put ADO_PAT
wrangler secret put MCP_API_KEY
wrangler deploy
```

## Code Conventions

### State Mapping
The project uses a specific mapping between Claude task states and ADO states:
- `pending` → "To Do"
- `in_progress` → "Active"
- `completed` → "Closed"
- `deleted` → "Removed"

### Authentication
The Worker API accepts authentication via:
- `x-api-key: <MCP_API_KEY>` header
- `Authorization: Bearer <MCP_API_KEY>` header

Both are validated against the `MCP_API_KEY` secret.

### Rate Limiting
The Worker implements a 10 req/sec rate limit per source IP using a sliding window with KV storage.

### Session Management
- With KV namespace binding: session state persists in KV storage
- Without KV: session state falls back to in-memory storage (may reset between isolates)

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `set_story` | Set the active User Story (auto-transitions to Active) |
| `task_create` | Create an ADO Task as a child of the active story |
| `task_update` | Update state, title, description, or assignee on a Task |
| `task_list` | List all Tasks under the active story |
| `task_get` | Get full details of a single Task |
| `task_link` | Create predecessor/successor dependency between Tasks |
| `task_list_mine` | List all Tasks assigned to @Me (filters for "To Do" or "Active" states only) |
| `story_resolve` | Mark the active User Story as Resolved |

## Making Changes

### Key Principles
- The Worker implementation is the primary codebase (no Python stdio implementation)
- Keep changes minimal and focused
- Validate with `node --check` before committing
- The project structure is intentionally simple - no build step required for the Worker code

### Common Tasks
- **Adding new MCP tools**: Add to `TOOL_DEFS` array and implement handler in the switch statement
- **Modifying ADO API calls**: Update the Azure DevOps REST API calls in worker.js
- **Changing state mapping**: Update the `STATE_MAP` constant
- **Adding secrets**: Use `wrangler secret put <SECRET_NAME>`

## Testing

There is no automated test suite. Validate changes by:
1. Running `node --check cloudflare/src/worker.js` for syntax validation
2. Deploying to a test Worker environment
3. Manually testing MCP tool calls via curl or MCP client

## Documentation

When making changes:
- Update README.md if changing user-facing functionality or deployment steps
- Update CLAUDE.md if changing task management behavior
- Update this file if changing architecture or adding new conventions
