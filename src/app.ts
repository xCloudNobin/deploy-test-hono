import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  PRIORITIES,
  PROJECT_STATUSES,
  TASK_STATUSES,
  probeDb,
  type Db,
  type Priority,
  type ProjectStatus,
  type TaskStatus,
} from "./db.js";
import type { Config } from "./config.js";

export interface AppOptions {
  config: Config;
  db: Db | null;
}

// ---------------------------------------------------------------------------
// Domain errors mapped to HTTP errors by app.onError
// ---------------------------------------------------------------------------

class HttpError extends Error {
  readonly status: number;
  readonly fields: Record<string, string>;

  constructor(status: number, message: string, fields: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

class BadRequestError extends HttpError {
  constructor(message: string, fields: Record<string, string> = {}) {
    super(400, message, fields);
  }
}

class ServiceUnavailableError extends HttpError {
  constructor() {
    super(503, "Service Unavailable");
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 2000;
const NAME_MAX = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new BadRequestError("Request body is not valid JSON");
  }
  if (!isRecord(body)) throw new BadRequestError("Request body must be a JSON object");
  return body;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new BadRequestError("Field must be a string");
  return value;
}

function parseId(value: unknown): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new BadRequestError("Invalid identifier");
  return id;
}

function parseStatus(value: unknown): TaskStatus {
  if (value === undefined || value === null || value === "") return "todo";
  if (!TASK_STATUSES.includes(value as TaskStatus)) {
    throw new BadRequestError(`Status must be one of: ${TASK_STATUSES.join(", ")}`);
  }
  return value as TaskStatus;
}

function parsePriority(value: unknown): Priority {
  if (value === undefined || value === null || value === "") return "medium";
  if (!PRIORITIES.includes(value as Priority)) {
    throw new BadRequestError(`Priority must be one of: ${PRIORITIES.join(", ")}`);
  }
  return value as Priority;
}

function parseProjectStatus(value: unknown): ProjectStatus {
  if (value === undefined || value === null || value === "") return "active";
  if (!PROJECT_STATUSES.includes(value as ProjectStatus)) {
    throw new BadRequestError(`Project status must be one of: ${PROJECT_STATUSES.join(", ")}`);
  }
  return value as ProjectStatus;
}

interface TaskInput {
  project_id: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
}

function validateTaskInput(body: Record<string, unknown>, requireProject: boolean): TaskInput {
  const fields: Record<string, string> = {};

  const projectValue = body.project_id;
  let projectId = 0;
  if (projectValue === undefined || projectValue === null) {
    if (requireProject) fields.project_id = "project_id is required";
  } else if (typeof projectValue !== "number" || !Number.isInteger(projectValue) || projectValue < 1) {
    fields.project_id = "project_id must be a positive integer";
  } else {
    projectId = projectValue;
  }

  const titleValue = body.title;
  let title = "";
  if (typeof titleValue !== "string" || titleValue.trim() === "") {
    fields.title =
      typeof titleValue === "string"
        ? "title is required and must not be blank"
        : "title is required and must be a string";
  } else {
    title = titleValue.trim();
    if (title.length > TITLE_MAX) fields.title = `title must be ${TITLE_MAX} characters or fewer`;
  }

  let description = "";
  const descriptionValue = optionalString(body.description);
  if (descriptionValue !== undefined) {
    description = descriptionValue.trim();
    if (description.length > DESCRIPTION_MAX) {
      fields.description = `description must be ${DESCRIPTION_MAX} characters or fewer`;
    }
  }

  let status: TaskStatus = "todo";
  let priority: Priority = "medium";
  try {
    status = parseStatus(body.status);
    priority = parsePriority(body.priority);
  } catch (err) {
    if (err instanceof BadRequestError) fields.status = err.message;
    else throw err;
  }

  if (Object.keys(fields).length > 0) throw new BadRequestError("Validation failed", fields);
  if (requireProject && !projectId) {
    throw new BadRequestError("Validation failed", { project_id: "project_id is required" });
  }

  return { project_id: projectId, title, description, status, priority };
}

interface ProjectInput {
  name: string;
  description: string;
  status: ProjectStatus;
}

function validateProjectInput(body: Record<string, unknown>): ProjectInput {
  const fields: Record<string, string> = {};

  const nameValue = body.name;
  let name = "";
  if (typeof nameValue !== "string" || nameValue.trim() === "") {
    fields.name =
      typeof nameValue === "string"
        ? "name is required and must not be blank"
        : "name is required and must be a string";
  } else {
    name = nameValue.trim();
    if (name.length > NAME_MAX) fields.name = `name must be ${NAME_MAX} characters or fewer`;
  }

  let description = "";
  const descriptionValue = optionalString(body.description);
  if (descriptionValue !== undefined) {
    description = descriptionValue.trim();
    if (description.length > DESCRIPTION_MAX) {
      fields.description = `description must be ${DESCRIPTION_MAX} characters or fewer`;
    }
  }

  let status: ProjectStatus = "active";
  try {
    status = parseProjectStatus(body.status);
  } catch (err) {
    if (err instanceof BadRequestError) fields.status = err.message;
    else throw err;
  }

  if (Object.keys(fields).length > 0) throw new BadRequestError("Validation failed", fields);
  return { name, description, status };
}

// ---------------------------------------------------------------------------
// DB helpers + row types
// ---------------------------------------------------------------------------

interface TaskRow {
  id: number;
  project_id: number;
  project_name: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  created_at: string;
  updated_at: string;
}

interface ProjectRow {
  id: number;
  name: string;
  description: string;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
}

const PROJECT_SELECT = `SELECT id, name, description, status, created_at, updated_at FROM project`;

function getProject(db: Db, id: number): ProjectRow | null {
  const row = db.prepare(`${PROJECT_SELECT} WHERE id = ?`).get(id);
  return row ? (row as ProjectRow) : null;
}

const TASK_SELECT = `SELECT t.id, t.project_id, p.name AS project_name, t.title, t.description,
                            t.status, t.priority, t.created_at, t.updated_at
                       FROM task t JOIN project p ON p.id = t.project_id`;

function getTask(db: Db, id: number): TaskRow | null {
  const row = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id);
  return row ? (row as TaskRow) : null;
}

function requireDb(opts: AppOptions): Db {
  if (opts.db === null) throw new ServiceUnavailableError();
  return opts.db;
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export function createApp(opts: AppOptions): Hono {
  const { config } = opts;
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      if (err instanceof ServiceUnavailableError) {
        return c.json({ error: "Service Unavailable", db: "unavailable" }, 503);
      }
      const body: Record<string, unknown> = { error: err.message };
      if (Object.keys(err.fields).length > 0) body.fields = err.fields;
      return c.json(body, err.status as ContentfulStatusCode);
    }
    console.error("[taskboard] request failed:", err instanceof Error ? err.message : err);
    return c.json({ error: "Internal Server Error" }, 500);
  });

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  // ---- health -------------------------------------------------------------
  app.get("/api/health/live", (c) =>
    c.json({ status: "alive", timestamp: new Date().toISOString() }),
  );

  app.get("/api/health/ready", (c) => {
    const probe = probeDb(config.dbPath);
    if (probe.ok) return c.json({ status: "ready", db: "sqlite", checked_at: probe.detail || null });
    return c.json({ status: "unavailable", db: "sqlite", detail: probe.detail }, 503);
  });

  app.get("/api/meta", (c) =>
    c.json({
      name: "deploy-test-hono",
      description:
        "Hono taskboard (Node adapter): SQLite persistence, validated CRUD, search/filter.",
      release: config.buildMarker,
      runtime: { name: "node", adapter: "@hono/node-server", version: process.version },
      database: { engine: "sqlite", path: config.dbPath },
    }),
  );

  // ---- projects -----------------------------------------------------------
  app.get("/api/projects", (c) => {
    const db = requireDb(opts);
    const rows = db
      .prepare(
        `SELECT p.id, p.name, p.description, p.status, p.created_at, p.updated_at,
                COUNT(t.id) AS task_total,
                SUM(CASE WHEN t.status = 'todo' THEN 1 ELSE 0 END) AS todo,
                SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
                SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done
           FROM project p LEFT JOIN task t ON t.project_id = p.id
          GROUP BY p.id ORDER BY p.id ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return c.json({
      projects: rows.map((r) => ({
        ...r,
        task_total: Number(r.task_total) ?? 0,
        todo: Number(r.todo) ?? 0,
        in_progress: Number(r.in_progress) ?? 0,
        done: Number(r.done) ?? 0,
      })),
    });
  });

  app.post("/api/projects", async (c) => {
    const db = requireDb(opts);
    const input = validateProjectInput(await readJsonObject(c));
    const res = db
      .prepare("INSERT INTO project (name, description, status) VALUES (?, ?, ?)")
      .run(input.name, input.description, input.status);
    const project = getProject(db, Number(res.lastInsertRowid));
    return c.json({ project }, 201);
  });

  app.get("/api/projects/:id", (c) => {
    const db = requireDb(opts);
    const id = parseId(c.req.param("id"));
    const project = getProject(db, id);
    if (!project) return c.json({ error: "Project not found" }, 404);
    const tasks = db
      .prepare("SELECT * FROM task WHERE project_id = ? ORDER BY id DESC")
      .all(id) as TaskRow[];
    return c.json({ project, tasks });
  });

  app.patch("/api/projects/:id", async (c) => {
    const db = requireDb(opts);
    const id = parseId(c.req.param("id"));
    const current = getProject(db, id);
    if (!current) return c.json({ error: "Project not found" }, 404);
    const body = await readJsonObject(c);
    if (body.name === undefined && body.description === undefined && body.status === undefined) {
      throw new BadRequestError("Nothing to update: provide at least one of name, description, status");
    }
    const merged: Record<string, unknown> = {
      name: body.name ?? current.name,
      description: body.description ?? current.description,
      status: body.status ?? current.status,
    };
    const input = validateProjectInput(merged);
    db.prepare(
      "UPDATE project SET name = ?, description = ?, status = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(input.name, input.description, input.status, id);
    return c.json({ project: getProject(db, id) });
  });

  app.delete("/api/projects/:id", (c) => {
    const db = requireDb(opts);
    const id = parseId(c.req.param("id"));
    const res = db.prepare("DELETE FROM project WHERE id = ?").run(id);
    if (Number(res.changes) === 0) return c.json({ error: "Project not found" }, 404);
    return c.body(null, 204);
  });

  // ---- tasks --------------------------------------------------------------
  app.get("/api/tasks", (c) => {
    const db = requireDb(opts);
    const q = c.req.query("q")?.trim() ?? "";
    const statusParam = c.req.query("status")?.trim() || null;
    const priorityParam = c.req.query("priority")?.trim() || null;
    const projectRaw = c.req.query("project_id")?.trim() || null;
    const projectId = projectRaw === null || projectRaw === "" ? null : parseId(projectRaw);

    if (statusParam !== null && !TASK_STATUSES.includes(statusParam as TaskStatus)) {
      throw new BadRequestError(`status filter must be one of: ${TASK_STATUSES.join(", ")}`);
    }
    if (priorityParam !== null && !PRIORITIES.includes(priorityParam as Priority)) {
      throw new BadRequestError(`priority filter must be one of: ${PRIORITIES.join(", ")}`);
    }

    const like = q ? `%${escapeLike(q)}%` : null;

    const tasks = db
      .prepare(
        `SELECT t.id, t.project_id, p.name AS project_name, t.title, t.description,
                t.status, t.priority, t.created_at, t.updated_at
           FROM task t JOIN project p ON p.id = t.project_id
          WHERE (($project IS NULL) OR t.project_id = $project)
            AND (($status IS NULL) OR t.status = $status)
            AND (($priority IS NULL) OR t.priority = $priority)
            AND (($q IS NULL) OR t.title LIKE $q ESCAPE '\\' OR t.description LIKE $q ESCAPE '\\')
          ORDER BY t.id DESC`,
      )
      .all({ project: projectId, status: statusParam, priority: priorityParam, q: like }) as TaskRow[];

    return c.json({
      tasks,
      count: tasks.length,
      query: { q, status: statusParam, priority: priorityParam, project_id: projectId },
    });
  });

  app.post("/api/tasks", async (c) => {
    const db = requireDb(opts);
    const body = await readJsonObject(c);
    const input = validateTaskInput(body, true);
    if (!getProject(db, input.project_id)) {
      throw new BadRequestError("project_id does not exist", { project_id: "no project with that id" });
    }
    const res = db
      .prepare(
        "INSERT INTO task (project_id, title, description, status, priority) VALUES (?, ?, ?, ?, ?)",
      )
      .run(input.project_id, input.title, input.description, input.status, input.priority);
    const task = getTask(db, Number(res.lastInsertRowid));
    return c.json({ task }, 201);
  });

  app.get("/api/tasks/:id", (c) => {
    const db = requireDb(opts);
    const id = parseId(c.req.param("id"));
    const task = getTask(db, id);
    if (!task) return c.json({ error: "Task not found" }, 404);
    return c.json({ task });
  });

  app.patch("/api/tasks/:id", async (c) => {
    const db = requireDb(opts);
    const id = parseId(c.req.param("id"));
    const current = getTask(db, id);
    if (!current) return c.json({ error: "Task not found" }, 404);
    const body = await readJsonObject(c);
    const keys = ["title", "description", "status", "priority", "project_id"];
    if (!keys.some((k) => body[k] !== undefined)) {
      throw new BadRequestError("Nothing to update: provide at least one of title, description, status, priority");
    }
    const merged: Record<string, unknown> = {};
    for (const k of ["title", "description", "status", "priority", "project_id"] as const) {
      if (body[k] !== undefined) merged[k] = body[k];
    }
    const input = validateTaskInput(merged, false);
    if (input.project_id && !getProject(db, input.project_id)) {
      throw new BadRequestError("project_id does not exist", { project_id: "no project with that id" });
    }
    if (!input.project_id) input.project_id = current.project_id;
    db.prepare(
      `UPDATE task SET project_id = ?, title = ?, description = ?, status = ?, priority = ?,
              updated_at = datetime('now') WHERE id = ?`,
    ).run(input.project_id, input.title, input.description, input.status, input.priority, id);
    return c.json({ task: getTask(db, id) });
  });

  app.delete("/api/tasks/:id", (c) => {
    const db = requireDb(opts);
    const id = parseId(c.req.param("id"));
    const res = db.prepare("DELETE FROM task WHERE id = ?").run(id);
    if (Number(res.changes) === 0) return c.json({ error: "Task not found" }, 404);
    return c.body(null, 204);
  });

  // ---- static UI (after the JSON API so API routes take precedence) --------
  app.get("*", serveStatic({ root: "./public" }));

  return app;
}