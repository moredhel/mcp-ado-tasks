# Task Management

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
