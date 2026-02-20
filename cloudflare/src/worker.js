const STATE_MAP = {
  pending: "To Do",
  in_progress: "Active",
  completed: "Closed",
  deleted: "Removed",
};

const STORY_ACTIVE_STATES = new Set(["New", "Approved", "Committed", "Design"]);
const memorySessions = new Map();

const TOOL_DEFS = [
  {
    name: "set_story",
    description:
      "Set the active User Story for this session. All task operations target this story.",
    inputSchema: {
      type: "object",
      properties: {
        story_id: { type: "string", description: "ADO Work Item ID of the User Story" },
      },
      required: ["story_id"],
    },
  },
  {
    name: "task_create",
    description: "Create an ADO Task as a child of the active story.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Task title" },
        description: { type: "string", description: "Task description (HTML or plain text)" },
        active_form: {
          type: "string",
          description: "Present-continuous label (e.g. 'Running tests')",
        },
      },
      required: ["subject", "description"],
    },
  },
  {
    name: "task_update",
    description: "Update fields or state on an existing ADO Task.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "ADO Work Item ID of the Task" },
        status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] },
        subject: { type: "string" },
        description: { type: "string" },
        owner: { type: "string", description: "Assignee email or display name" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "task_list",
    description: "List all Tasks that are children of the active story.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "task_get",
    description: "Get full details of a single Task Work Item.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string", description: "ADO Work Item ID" } },
      required: ["task_id"],
    },
  },
  {
    name: "task_link",
    description: "Create a predecessor/successor dependency link between two tasks.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The dependent task (successor)" },
        depends_on_id: { type: "string", description: "The task it depends on (predecessor)" },
      },
      required: ["task_id", "depends_on_id"],
    },
  },
  {
    name: "task_list_mine",
    description: "List all Tasks across the project that are assigned to the current user (@Me).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "story_resolve",
    description: "Mark the active User Story as Resolved. Call this when implementation work is complete.",
    inputSchema: { type: "object", properties: {} },
  },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "ado-tasks-mcp-worker" });
    }
    if (url.pathname !== "/mcp") {
      return json({ error: "Not found" }, 404);
    }
    if (!_isAuthorized(request, env)) {
      return json({ error: "Unauthorized" }, 401);
    }
    
    // Rate limiting check
    const rateLimitResult = await _checkRateLimit(request, env);
    if (!rateLimitResult.allowed) {
      return json(
        { 
          error: "Rate limit exceeded", 
          message: "Maximum 10 requests per second allowed",
          retry_after: rateLimitResult.retryAfter 
        }, 
        429,
        { "Retry-After": String(rateLimitResult.retryAfter) }
      );
    }
    
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const body = await request.json();
    const sessionId = _sessionId(request);
    if (Array.isArray(body)) {
      const responses = await Promise.all(body.map((item) => handleRpc(item, env, sessionId)));
      return json(responses.filter((r) => r !== null));
    }
    const response = await handleRpc(body, env, sessionId);
    if (response === null) {
      return new Response(null, { status: 204 });
    }
    return json(response, 200, { "Mcp-Session-Id": sessionId });
  },
};

async function handleRpc(msg, env, sessionId) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg?.id, -32600, "Invalid Request");
  }
  const { id, method } = msg;
  const params = msg.params ?? {};

  if (method === "notifications/initialized" || id === undefined) {
    return null;
  }

  try {
    if (method === "initialize") {
      return rpcResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "ado-tasks-mcp-worker", version: "1.0.0" },
      });
    }
    if (method === "ping") {
      return rpcResult(id, {});
    }
    if (method === "tools/list") {
      return rpcResult(id, { tools: TOOL_DEFS });
    }
    if (method === "tools/call") {
      const result = await dispatchTool(params.name, params.arguments ?? {}, env, sessionId);
      return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    }
    return rpcError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    return rpcResult(id, {
      content: [{ type: "text", text: JSON.stringify({ error: String(error.message || error) }, null, 2) }],
      isError: true,
    });
  }
}

async function dispatchTool(name, args, env, sessionId) {
  if (name === "set_story") return setStory(args.story_id, env, sessionId);
  if (name === "task_create") return taskCreate(args.subject, args.description, args.active_form, env, sessionId);
  if (name === "task_update")
    return taskUpdate(args.task_id, args.status, args.subject, args.description, args.owner, env);
  if (name === "task_list") return taskList(env, sessionId);
  if (name === "task_get") return taskGet(args.task_id, env);
  if (name === "task_link") return taskLink(args.task_id, args.depends_on_id, env);
  if (name === "task_list_mine") return taskListMine(env);
  if (name === "story_resolve") return storyResolve(env, sessionId);
  throw new Error(`Unknown tool: ${name}`);
}

function _requiredEnv(env) {
  if (!env.ADO_PAT || !env.ADO_ORG || !env.ADO_PROJECT) {
    throw new Error("ADO_PAT, ADO_ORG and ADO_PROJECT are required");
  }
}

function _orgUrl(env) {
  return `https://dev.azure.com/${env.ADO_ORG}`;
}

async function adoRequest(env, method, path, body, contentType = "application/json") {
  _requiredEnv(env);
  const url = `${_orgUrl(env)}/${env.ADO_PROJECT}/_apis${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${btoa(`:${env.ADO_PAT}`)}`,
      Accept: "application/json",
      "Content-Type": contentType,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`ADO ${method} ${url} → ${res.status}: ${text}`);
  }
  return parsed;
}

async function getActiveStoryId(env, sessionId) {
  const key = `story:${sessionId}`;
  const sid = env.SESSION_KV ? await env.SESSION_KV.get(key) : memorySessions.get(key);
  if (!sid) throw new Error("No active story set. Call set_story first.");
  return sid;
}

async function saveStoryId(env, sessionId, storyId) {
  const key = `story:${sessionId}`;
  if (env.SESSION_KV) {
    await env.SESSION_KV.put(key, storyId);
    return;
  }
  memorySessions.set(key, storyId);
}

async function setStory(storyId, env, sessionId) {
  const wi = await adoRequest(env, "GET", `/wit/workitems/${storyId}?api-version=7.1`);
  const fields = wi.fields ?? {};
  const title = fields["System.Title"] ?? "(unknown)";
  const type = fields["System.WorkItemType"] ?? "";
  const currentState = fields["System.State"] ?? "";
  await saveStoryId(env, sessionId, storyId);

  let transitioned = false;
  if (STORY_ACTIVE_STATES.has(currentState)) {
    await adoRequest(
      env,
      "PATCH",
      `/wit/workitems/${storyId}?api-version=7.1`,
      [{ op: "add", path: "/fields/System.State", value: "Active" }],
      "application/json-patch+json",
    );
    transitioned = true;
  }
  return {
    story_id: storyId,
    title,
    type,
    state: transitioned ? "Active" : currentState,
    message: `Active story set to #${storyId}: ${title}${transitioned ? " (moved to Active)" : ""}`,
  };
}

async function taskCreate(subject, description, activeForm, env, sessionId) {
  const storyId = await getActiveStoryId(env, sessionId);
  const patch = [
    { op: "add", path: "/fields/System.Title", value: subject },
    { op: "add", path: "/fields/System.Description", value: description },
    {
      op: "add",
      path: "/relations/-",
      value: {
        rel: "System.LinkTypes.Hierarchy-Reverse",
        url: `${_orgUrl(env)}/_apis/wit/workitems/${storyId}`,
        attributes: { comment: "Child of story" },
      },
    },
  ];
  if (activeForm) patch.push({ op: "add", path: "/fields/System.History", value: activeForm });
  const wi = await adoRequest(
    env,
    "POST",
    "/wit/workitems/$Task?api-version=7.1",
    patch,
    "application/json-patch+json",
  );
  return {
    task_id: String(wi.id),
    title: wi.fields?.["System.Title"] ?? subject,
    parent_story_id: storyId,
  };
}

async function taskUpdate(taskId, status, subject, description, owner, env) {
  const patch = [];
  if (status) {
    const adoState = STATE_MAP[status];
    if (!adoState) throw new Error(`Unknown status '${status}'. Use: ${Object.keys(STATE_MAP).join(", ")}`);
    patch.push({ op: "add", path: "/fields/System.State", value: adoState });
  }
  if (subject) patch.push({ op: "add", path: "/fields/System.Title", value: subject });
  if (description) patch.push({ op: "add", path: "/fields/System.Description", value: description });
  if (owner) patch.push({ op: "add", path: "/fields/System.AssignedTo", value: owner });
  if (!patch.length) return { task_id: taskId, message: "No fields to update" };

  const wi = await adoRequest(
    env,
    "PATCH",
    `/wit/workitems/${taskId}?api-version=7.1`,
    patch,
    "application/json-patch+json",
  );
  return {
    task_id: taskId,
    title: wi.fields?.["System.Title"],
    state: wi.fields?.["System.State"],
  };
}

async function taskList(env, sessionId) {
  const storyId = await getActiveStoryId(env, sessionId);
  const wiql = {
    query: `
SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo]
FROM WorkItemLinks
WHERE [Source].[System.Id] = ${storyId}
  AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward'
  AND [Target].[System.WorkItemType] = 'Task'
MODE (MayContain)
`,
  };
  const result = await adoRequest(env, "POST", "/wit/wiql?api-version=7.1", wiql);
  const relations = result.workItemRelations ?? [];
  const ids = relations.map((r) => r.target?.id).filter(Boolean);
  if (!ids.length) return { story_id: storyId, tasks: [] };

  const fields = "System.Id,System.Title,System.State,System.AssignedTo";
  const batch = await adoRequest(
    env,
    "GET",
    `/wit/workitems?ids=${ids.join(",")}&fields=${fields}&api-version=7.1`,
  );
  const tasks = (batch.value ?? []).map((wi) => {
    const f = wi.fields ?? {};
    const assigned = f["System.AssignedTo"];
    return {
      task_id: String(wi.id),
      title: f["System.Title"],
      state: f["System.State"],
      owner: typeof assigned === "object" ? assigned.displayName : assigned,
    };
  });
  return { story_id: storyId, tasks };
}

async function taskGet(taskId, env) {
  const wi = await adoRequest(env, "GET", `/wit/workitems/${taskId}?$expand=relations&api-version=7.1`);
  const f = wi.fields ?? {};
  const assigned = f["System.AssignedTo"];
  return {
    task_id: String(wi.id),
    title: f["System.Title"],
    description: f["System.Description"],
    state: f["System.State"],
    owner: typeof assigned === "object" ? assigned.displayName : assigned,
    relations: (wi.relations ?? []).map((rel) => ({
      rel: rel.rel,
      url: rel.url,
      attributes: rel.attributes ?? {},
    })),
  };
}

async function storyResolve(env, sessionId) {
  const storyId = await getActiveStoryId(env, sessionId);
  await adoRequest(
    env,
    "PATCH",
    `/wit/workitems/${storyId}?api-version=7.1`,
    [{ op: "add", path: "/fields/System.State", value: "Resolved" }],
    "application/json-patch+json",
  );
  return {
    story_id: storyId,
    state: "Resolved",
    message: `Story #${storyId} marked as Resolved.`,
  };
}

async function taskListMine(env) {
  const wiql = {
    query: `
SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo], [System.Parent]
FROM WorkItems
WHERE [System.WorkItemType] = 'Task'
  AND [System.AssignedTo] = @Me
  AND ([System.State] = 'To Do' OR [System.State] = 'Active')
ORDER BY [System.ChangedDate] DESC
`,
  };
  const result = await adoRequest(env, "POST", "/wit/wiql?api-version=7.1", wiql);
  const workItems = result.workItems ?? [];
  if (!workItems.length) return { tasks: [] };

  const ids = workItems.map((wi) => wi.id).join(",");
  const fields = "System.Id,System.Title,System.State,System.AssignedTo,System.Parent";
  const batch = await adoRequest(env, "GET", `/wit/workitems?ids=${ids}&fields=${fields}&api-version=7.1`);
  const tasks = (batch.value ?? []).map((wi) => {
    const f = wi.fields ?? {};
    const assigned = f["System.AssignedTo"];
    return {
      task_id: String(wi.id),
      title: f["System.Title"],
      state: f["System.State"],
      owner: typeof assigned === "object" ? assigned.displayName : assigned,
      parent_id: f["System.Parent"] ? String(f["System.Parent"]) : null,
    };
  });
  return { tasks };
}

async function taskLink(taskId, dependsOnId, env) {
  await adoRequest(
    env,
    "PATCH",
    `/wit/workitems/${taskId}?api-version=7.1`,
    [
      {
        op: "add",
        path: "/relations/-",
        value: {
          rel: "System.LinkTypes.Dependency-Forward",
          url: `${_orgUrl(env)}/_apis/wit/workitems/${dependsOnId}`,
          attributes: { comment: `Depends on #${dependsOnId}` },
        },
      },
    ],
    "application/json-patch+json",
  );
  return {
    task_id: taskId,
    depends_on_id: dependsOnId,
    message: `Task #${taskId} now depends on #${dependsOnId}`,
  };
}

function _sessionId(request) {
  return (
    request.headers.get("mcp-session-id") ||
    request.headers.get("x-session-id") ||
    "default"
  );
}

async function _checkRateLimit(request, env) {
  const RATE_LIMIT = 10; // requests per second
  const WINDOW_SIZE = 1; // 1 second window
  
  // Get client IP from CF-Connecting-IP header (set by Cloudflare)
  const clientIP = request.headers.get("CF-Connecting-IP") || 
                   request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
                   "unknown";
  
  const now = Date.now();
  const windowStart = Math.floor(now / 1000); // Current second
  const key = `ratelimit:${clientIP}:${windowStart}`;
  
  // Use KV if available, otherwise use in-memory fallback
  let count = 0;
  if (env.RATE_LIMIT_KV) {
    const stored = await env.RATE_LIMIT_KV.get(key);
    count = stored ? parseInt(stored, 10) : 0;
  } else if (env.SESSION_KV) {
    // Fallback to SESSION_KV if RATE_LIMIT_KV not configured
    const stored = await env.SESSION_KV.get(key);
    count = stored ? parseInt(stored, 10) : 0;
  } else {
    // In-memory fallback (will reset between isolates, but better than nothing)
    if (!globalThis.rateLimitMemory) {
      globalThis.rateLimitMemory = new Map();
    }
    // Clean up old entries
    const cutoff = windowStart - 2; // Keep last 2 seconds
    for (const [k, v] of globalThis.rateLimitMemory.entries()) {
      const timestamp = parseInt(k.split(":")[2], 10);
      if (timestamp < cutoff) {
        globalThis.rateLimitMemory.delete(k);
      }
    }
    count = globalThis.rateLimitMemory.get(key) || 0;
  }
  
  if (count >= RATE_LIMIT) {
    return { 
      allowed: false, 
      retryAfter: 1 // Retry after 1 second
    };
  }
  
  // Increment counter
  count += 1;
  if (env.RATE_LIMIT_KV) {
    await env.RATE_LIMIT_KV.put(key, String(count), { expirationTtl: 2 });
  } else if (env.SESSION_KV) {
    await env.SESSION_KV.put(key, String(count), { expirationTtl: 2 });
  } else {
    globalThis.rateLimitMemory.set(key, count);
  }
  
  return { allowed: true };
}

function _isAuthorized(request, env) {
  if (!env.MCP_API_KEY) return false;
  const xApiKey = request.headers.get("x-api-key");
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null; // 'Bearer ' is 7 chars
  return xApiKey === env.MCP_API_KEY || bearer === env.MCP_API_KEY;
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}
