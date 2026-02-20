#!/usr/bin/env python3
"""Azure DevOps MCP Server — Task management adapter for Claude Code."""

import json
import os
import sys
import urllib.request
import urllib.error
import base64
from pathlib import Path

# MCP SDK
try:
    import mcp.server.stdio
    import mcp.types as types
    from mcp.server import Server
except ImportError:
    print("Error: mcp package not installed. Run: pip install mcp", file=sys.stderr)
    sys.exit(1)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

ADO_PAT = os.environ.get("ADO_PAT", "")
ADO_ORG = os.environ.get("ADO_ORG", "")
ADO_PROJECT = os.environ.get("ADO_PROJECT", "")

SESSION_FILE = Path.home() / ".local" / "share" / "life-manager" / "session.json"
SESSION_FILE.parent.mkdir(parents=True, exist_ok=True)

STATE_MAP = {
    "pending":     "To Do",
    "in_progress": "Active",
    "completed":   "Closed",
    "deleted":     "Removed",
}

# ---------------------------------------------------------------------------
# ADO HTTP helpers
# ---------------------------------------------------------------------------

def _auth_header() -> str:
    token = base64.b64encode(f":{ADO_PAT}".encode()).decode()
    return f"Basic {token}"


def _ado_request(method: str, path: str, body=None, content_type="application/json") -> dict:
    url = f"https://dev.azure.com/{ADO_ORG}/{ADO_PROJECT}/_apis{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": _auth_header(),
            "Content-Type": content_type,
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        raise RuntimeError(f"ADO {method} {url} → {e.code}: {detail}") from e


def _org_url() -> str:
    return f"https://dev.azure.com/{ADO_ORG}"


# ---------------------------------------------------------------------------
# Session helpers
# ---------------------------------------------------------------------------

def _load_session() -> dict:
    if SESSION_FILE.exists():
        return json.loads(SESSION_FILE.read_text())
    return {}


def _save_session(data: dict) -> None:
    SESSION_FILE.write_text(json.dumps(data, indent=2))


def _active_story_id() -> str:
    sid = _load_session().get("story_id")
    if not sid:
        raise RuntimeError("No active story set. Call set_story first.")
    return sid


# ---------------------------------------------------------------------------
# MCP Server
# ---------------------------------------------------------------------------

server = Server("tasks")


@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name="set_story",
            description="Set the active User Story for this session. All task operations target this story.",
            inputSchema={
                "type": "object",
                "properties": {
                    "story_id": {"type": "string", "description": "ADO Work Item ID of the User Story"}
                },
                "required": ["story_id"],
            },
        ),
        types.Tool(
            name="task_create",
            description="Create an ADO Task as a child of the active story.",
            inputSchema={
                "type": "object",
                "properties": {
                    "subject":     {"type": "string", "description": "Task title"},
                    "description": {"type": "string", "description": "Task description (HTML or plain text)"},
                    "active_form": {"type": "string", "description": "Present-continuous label (e.g. 'Running tests')"},
                },
                "required": ["subject", "description"],
            },
        ),
        types.Tool(
            name="task_update",
            description="Update fields or state on an existing ADO Task.",
            inputSchema={
                "type": "object",
                "properties": {
                    "task_id":     {"type": "string", "description": "ADO Work Item ID of the Task"},
                    "status":      {"type": "string", "enum": ["pending", "in_progress", "completed", "deleted"]},
                    "subject":     {"type": "string"},
                    "description": {"type": "string"},
                    "owner":       {"type": "string", "description": "Assignee email or display name"},
                },
                "required": ["task_id"],
            },
        ),
        types.Tool(
            name="task_list",
            description="List all Tasks that are children of the active story.",
            inputSchema={"type": "object", "properties": {}},
        ),
        types.Tool(
            name="task_get",
            description="Get full details of a single Task Work Item.",
            inputSchema={
                "type": "object",
                "properties": {
                    "task_id": {"type": "string", "description": "ADO Work Item ID"}
                },
                "required": ["task_id"],
            },
        ),
        types.Tool(
            name="task_link",
            description="Create a predecessor/successor dependency link between two tasks.",
            inputSchema={
                "type": "object",
                "properties": {
                    "task_id":       {"type": "string", "description": "The dependent task (successor)"},
                    "depends_on_id": {"type": "string", "description": "The task it depends on (predecessor)"},
                },
                "required": ["task_id", "depends_on_id"],
            },
        ),
        types.Tool(
            name="task_list_mine",
            description="List all Tasks across the project that are assigned to the current user (@Me).",
            inputSchema={"type": "object", "properties": {}},
        ),
        types.Tool(
            name="story_resolve",
            description="Mark the active User Story as Resolved. Call this when implementation work is complete.",
            inputSchema={"type": "object", "properties": {}},
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[types.TextContent]:
    try:
        result = _dispatch(name, arguments)
    except Exception as exc:
        result = {"error": str(exc)}
    return [types.TextContent(type="text", text=json.dumps(result, indent=2))]


def _dispatch(name: str, args: dict) -> dict:
    if name == "set_story":
        return _set_story(args["story_id"])
    if name == "task_create":
        return _task_create(args["subject"], args["description"], args.get("active_form"))
    if name == "task_update":
        return _task_update(
            args["task_id"],
            status=args.get("status"),
            subject=args.get("subject"),
            description=args.get("description"),
            owner=args.get("owner"),
        )
    if name == "task_list":
        return _task_list()
    if name == "task_get":
        return _task_get(args["task_id"])
    if name == "task_link":
        return _task_link(args["task_id"], args["depends_on_id"])
    if name == "task_list_mine":
        return _task_list_mine()
    if name == "story_resolve":
        return _story_resolve()
    raise ValueError(f"Unknown tool: {name}")


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

STORY_ACTIVE_STATES = {"New", "Approved", "Committed", "Design"}

def _set_story(story_id: str) -> dict:
    wi = _ado_request("GET", f"/wit/workitems/{story_id}?api-version=7.1")
    fields = wi.get("fields", {})
    title = fields.get("System.Title", "(unknown)")
    work_item_type = fields.get("System.WorkItemType", "")
    current_state = fields.get("System.State", "")
    _save_session({"story_id": story_id})

    transitioned = False
    if current_state in STORY_ACTIVE_STATES:
        _ado_request(
            "PATCH",
            f"/wit/workitems/{story_id}?api-version=7.1",
            body=[{"op": "add", "path": "/fields/System.State", "value": "Active"}],
            content_type="application/json-patch+json",
        )
        transitioned = True

    return {
        "story_id": story_id,
        "title": title,
        "type": work_item_type,
        "state": "Active" if transitioned else current_state,
        "message": f"Active story set to #{story_id}: {title}"
                   + (" (moved to Active)" if transitioned else ""),
    }


def _task_create(subject: str, description: str, active_form: str | None = None) -> dict:
    story_id = _active_story_id()
    patch = [
        {"op": "add", "path": "/fields/System.Title",       "value": subject},
        {"op": "add", "path": "/fields/System.Description", "value": description},
        {"op": "add", "path": "/relations/-", "value": {
            "rel": "System.LinkTypes.Hierarchy-Reverse",
            "url": f"{_org_url()}/_apis/wit/workitems/{story_id}",
            "attributes": {"comment": "Child of story"},
        }},
    ]
    if active_form:
        patch.append({"op": "add", "path": "/fields/System.History", "value": active_form})

    wi = _ado_request(
        "POST",
        "/wit/workitems/$Task?api-version=7.1",
        body=patch,
        content_type="application/json-patch+json",
    )
    task_id = str(wi["id"])
    title = wi.get("fields", {}).get("System.Title", subject)
    return {"task_id": task_id, "title": title, "parent_story_id": story_id}


def _task_update(
    task_id: str,
    status: str | None = None,
    subject: str | None = None,
    description: str | None = None,
    owner: str | None = None,
) -> dict:
    patch = []
    if status:
        ado_state = STATE_MAP.get(status)
        if not ado_state:
            raise ValueError(f"Unknown status '{status}'. Use: {list(STATE_MAP)}")
        patch.append({"op": "add", "path": "/fields/System.State", "value": ado_state})
    if subject:
        patch.append({"op": "add", "path": "/fields/System.Title", "value": subject})
    if description:
        patch.append({"op": "add", "path": "/fields/System.Description", "value": description})
    if owner:
        patch.append({"op": "add", "path": "/fields/System.AssignedTo", "value": owner})

    if not patch:
        return {"task_id": task_id, "message": "No fields to update"}

    wi = _ado_request(
        "PATCH",
        f"/wit/workitems/{task_id}?api-version=7.1",
        body=patch,
        content_type="application/json-patch+json",
    )
    return {
        "task_id": task_id,
        "title": wi.get("fields", {}).get("System.Title"),
        "state": wi.get("fields", {}).get("System.State"),
    }


def _task_list() -> dict:
    story_id = _active_story_id()
    wiql = {
        "query": f"""
SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo]
FROM WorkItemLinks
WHERE [Source].[System.Id] = {story_id}
  AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward'
  AND [Target].[System.WorkItemType] = 'Task'
MODE (MayContain)
"""
    }
    result = _ado_request("POST", "/wit/wiql?api-version=7.1", body=wiql)
    work_item_relations = result.get("workItemRelations", [])

    # Collect target IDs (skip the source row which has no target)
    ids = [
        str(r["target"]["id"])
        for r in work_item_relations
        if r.get("target")
    ]
    if not ids:
        return {"story_id": story_id, "tasks": []}

    ids_csv = ",".join(ids)
    fields = "System.Id,System.Title,System.State,System.AssignedTo"
    batch = _ado_request("GET", f"/wit/workitems?ids={ids_csv}&fields={fields}&api-version=7.1")

    tasks = []
    for wi in batch.get("value", []):
        f = wi.get("fields", {})
        assigned = f.get("System.AssignedTo")
        tasks.append({
            "task_id": str(wi["id"]),
            "title":   f.get("System.Title"),
            "state":   f.get("System.State"),
            "owner":   assigned.get("displayName") if isinstance(assigned, dict) else assigned,
        })
    return {"story_id": story_id, "tasks": tasks}


def _task_get(task_id: str) -> dict:
    wi = _ado_request("GET", f"/wit/workitems/{task_id}?$expand=relations&api-version=7.1")
    f = wi.get("fields", {})
    assigned = f.get("System.AssignedTo")
    relations = []
    for rel in wi.get("relations", []):
        relations.append({
            "rel":  rel.get("rel"),
            "url":  rel.get("url"),
            "attributes": rel.get("attributes", {}),
        })
    return {
        "task_id":     str(wi["id"]),
        "title":       f.get("System.Title"),
        "description": f.get("System.Description"),
        "state":       f.get("System.State"),
        "owner":       assigned.get("displayName") if isinstance(assigned, dict) else assigned,
        "relations":   relations,
    }


def _story_resolve() -> dict:
    story_id = _active_story_id()
    _ado_request(
        "PATCH",
        f"/wit/workitems/{story_id}?api-version=7.1",
        body=[{"op": "add", "path": "/fields/System.State", "value": "Resolved"}],
        content_type="application/json-patch+json",
    )
    return {
        "story_id": story_id,
        "state": "Resolved",
        "message": f"Story #{story_id} marked as Resolved.",
    }


def _task_list_mine() -> dict:
    wiql = {
        "query": """
SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo], [System.Parent]
FROM WorkItems
WHERE [System.WorkItemType] = 'Task'
  AND [System.AssignedTo] = @Me
  AND [System.State] <> 'Removed'
ORDER BY [System.ChangedDate] DESC
"""
    }
    result = _ado_request("POST", "/wit/wiql?api-version=7.1", body=wiql)
    work_items = result.get("workItems", [])
    if not work_items:
        return {"tasks": []}

    ids_csv = ",".join(str(wi["id"]) for wi in work_items)
    fields = "System.Id,System.Title,System.State,System.AssignedTo,System.Parent"
    batch = _ado_request("GET", f"/wit/workitems?ids={ids_csv}&fields={fields}&api-version=7.1")

    tasks = []
    for wi in batch.get("value", []):
        f = wi.get("fields", {})
        assigned = f.get("System.AssignedTo")
        tasks.append({
            "task_id":        str(wi["id"]),
            "title":          f.get("System.Title"),
            "state":          f.get("System.State"),
            "owner":          assigned.get("displayName") if isinstance(assigned, dict) else assigned,
            "parent_id":      str(f["System.Parent"]) if f.get("System.Parent") else None,
        })
    return {"tasks": tasks}


def _task_link(task_id: str, depends_on_id: str) -> dict:
    patch = [
        {"op": "add", "path": "/relations/-", "value": {
            "rel": "System.LinkTypes.Dependency-Forward",
            "url": f"{_org_url()}/_apis/wit/workitems/{depends_on_id}",
            "attributes": {"comment": f"Depends on #{depends_on_id}"},
        }}
    ]
    _ado_request(
        "PATCH",
        f"/wit/workitems/{task_id}?api-version=7.1",
        body=patch,
        content_type="application/json-patch+json",
    )
    return {
        "task_id":       task_id,
        "depends_on_id": depends_on_id,
        "message":       f"Task #{task_id} now depends on #{depends_on_id}",
    }


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

async def main():
    async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
