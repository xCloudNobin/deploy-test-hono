import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { createApp } from "../src/app.js";
import { defaultConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db.js";

let workDir: string;
let dbPath: string;
let db: Db;
let app: ReturnType<typeof createApp>;

const config = () => defaultConfig({ ...process.env, PORT: "8080" });

async function parseJson<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function createProject(name = "Test project") {
  const res = await app.request("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, description: "a", status: "active" }),
  });
  assert.equal(res.status, 201);
  return (await parseJson(res)).project as { id: number; name: string; status: string };
}

async function createTask(overrides: Record<string, unknown> = {}) {
  const payload = {
    project_id: overrides.project_id ?? 1,
    title: "Task title",
    description: "desc",
    status: "todo",
    priority: "medium",
    ...overrides,
  };
  const res = await app.request("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 201);
  return (await parseJson(res)).task as { id: number; project_id: number; title: string };
}

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "hono-taskboard-test-"));
  dbPath = join(workDir, "taskboard.db");
  db = openDb(dbPath);
  app = createApp({ config: { ...config(), dbPath, port: 0, dataDir: workDir, buildMarker: "test-marker" }, db });
});

after(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("health and readiness", () => {
  test("liveness is OK", async () => {
    const res = await app.request("/api/health/live");
    assert.equal(res.status, 200);
    const body = await parseJson(res);
    assert.equal(body.status, "alive");
  });

  test("readiness is OK when database reachable", async () => {
    const res = await app.request("/api/health/ready");
    assert.equal(res.status, 200);
    const body = await parseJson(res);
    assert.equal(body.status, "ready");
  });

  test("readiness fails when the database is unavailable while liveness stays up", async () => {
    const blockedDir = join(workDir, "blocked");
    writeFileSync(blockedDir, "a regular file, not a directory");
    const blockedPath = join(blockedDir, "unreachable.db");

    assert.throws(() => openDb(blockedPath));

    const degraded = createApp({
      config: { ...config(), dbPath: blockedPath, port: 0, dataDir: workDir, buildMarker: "test-marker" },
      db: null,
    });
    const live = await degraded.request("/api/health/live");
    assert.equal(live.status, 200);
    const ready = await degraded.request("/api/health/ready");
    assert.equal(ready.status, 503);
    const readyBody = (await ready.json()) as { status: string };
    assert.equal(readyBody.status, "unavailable");
    const list = await degraded.request("/api/projects");
    assert.equal(list.status, 503);
    const listBody = (await list.json()) as { error: string };
    assert.equal(listBody.error, "Service Unavailable");
  });

  test("meta exposes non-sensitive release marker", async () => {
    const res = await app.request("/api/meta");
    assert.equal(res.status, 200);
    const body = await parseJson<{ release: string; runtime: { name: string }; database: { engine: string } }>(res);
    assert.equal(body.release, "test-marker");
    assert.equal(body.runtime.name, "node");
    assert.equal(body.database.engine, "sqlite");
  });
});

describe("static UI", () => {
  test("serves index.html at /", async () => {
    const res = await app.request("/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await res.text(), /Hono Taskboard/);
  });

  test("serves client assets", async () => {
    const js = await app.request("/app.js");
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    const css = await app.request("/style.css");
    assert.equal(css.status, 200);
  });

  test("unknown asset is 404", async () => {
    const res = await app.request("/nope.txt");
    assert.equal(res.status, 404);
  });
});

describe("project CRUD with validation", () => {
  test("creates and lists projects", async () => {
    await createProject("CRUD alpha");
    const res = await app.request("/api/projects");
    assert.equal(res.status, 200);
    const body = await parseJson(res);
    const projects = (body.projects as Array<{ name: string }>);
    assert.ok(projects.some((p) => p.name === "CRUD alpha"));
    const seeded = projects.find((p) => p.name === "Launch checklist");
    assert.ok(seeded);
  });

  test("reads a project with its tasks", async () => {
    const project = await createProject("reads-with-tasks");
    const task = await createTask({ project_id: project.id, title: "child" });
    const res = await app.request(`/api/projects/${project.id}`);
    assert.equal(res.status, 200);
    const body = await parseJson(res);
    assert.equal((body.project as { id: number }).id, project.id);
    const tasks = body.tasks as Array<{ id: number }>;
    assert.ok(tasks.some((t) => t.id === task.id));
  });

  test("updates a project", async () => {
    const p = await createProject("rename-me");
    const res = await app.request(`/api/projects/${p.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "renamed", status: "archived" }),
    });
    assert.equal(res.status, 200);
    const body = await parseJson(res);
    assert.equal((body.project as { name: string }).name, "renamed");
    assert.equal((body.project as { status: string }).status, "archived");
  });

  test("deletes a project and cascades its tasks", async () => {
    const p = await createProject("to-delete");
    const task = await createTask({ project_id: p.id, title: "cascade me" });
    const res = await app.request(`/api/projects/${p.id}`, { method: "DELETE" });
    assert.equal(res.status, 204);
    assert.equal((await app.request(`/api/projects/${p.id}`)).status, 404);
    assert.equal((await app.request(`/api/tasks/${task.id}`)).status, 404);
  });

  test("rejects blank project name", async () => {
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "   ", status: "active" }),
    });
    assert.equal(res.status, 400);
    const body = await parseJson(res);
    assert.ok((body.fields as Record<string, string>).name);
  });

  test("rejects over-long project name", async () => {
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(121) }),
    });
    assert.equal(res.status, 400);
  });

  test("rejects invalid project status", async () => {
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ok", status: "warp" }),
    });
    assert.equal(res.status, 400);
  });

  test("rejects empty project patch", async () => {
    const p = await createProject("empty-patch");
    const res = await app.request(`/api/projects/${p.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 400);
  });
});

describe("task CRUD with validation", () => {
  test("creates, reads, lists tasks", async () => {
    const task = await createTask({ title: "first task", status: "done", priority: "high" });
    assert.equal(task.title, "first task");
    const got = await app.request(`/api/tasks/${task.id}`);
    assert.equal(got.status, 200);
    const body = await parseJson(got);
    assert.equal((body.task as { id: number }).id, task.id);
    const list = await app.request("/api/tasks?project_id=1");
    const listed = await parseJson(list);
    assert.ok((listed.tasks as Array<{ id: number }>).some((t) => t.id === task.id));
  });

  test("updates a task", async () => {
    const task = await createTask({ title: "before" });
    const res = await app.request(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "after", status: "in_progress", priority: "high" }),
    });
    assert.equal(res.status, 200);
    const body = await parseJson(res);
    const t = body.task as { title: string; status: string; priority: string };
    assert.equal(t.title, "after");
    assert.equal(t.status, "in_progress");
    assert.equal(t.priority, "high");
  });

  test("deletes a task", async () => {
    const task = await createTask({ title: "to-remove" });
    const res = await app.request(`/api/tasks/${task.id}`, { method: "DELETE" });
    assert.equal(res.status, 204);
    assert.equal((await app.request(`/api/tasks/${task.id}`)).status, 404);
  });

  test("rejects non-integer id with 400", async () => {
    assert.equal((await app.request("/api/tasks/abc")).status, 400);
    assert.equal((await app.request("/api/tasks/0")).status, 400);
  });

  test("rejects blank task title", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: 1, title: " \t ", status: "todo" }),
    });
    assert.equal(res.status, 400);
    const body = await parseJson(res);
    assert.ok((body.fields as Record<string, string>).title);
  });

  test("rejects non-string task title", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: 1, title: 42 }),
    });
    assert.equal(res.status, 400);
  });

  test("rejects over-long task title", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: 1, title: "x".repeat(201) }),
    });
    assert.equal(res.status, 400);
    const body = await parseJson(res);
    assert.ok((body.fields as Record<string, string>).title);
  });

  test("rejects invalid status and priority", async () => {
    const badStatus = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: 1, title: "x", status: "warp" }),
    });
    assert.equal(badStatus.status, 400);
    const badPriority = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: 1, title: "x", priority: "urgent" }),
    });
    assert.equal(badPriority.status, 400);
  });

  test("rejects missing or nonexistent project_id", async () => {
    const missing = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    assert.equal(missing.status, 400);
    const none = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: 999999, title: "x" }),
    });
    assert.equal(none.status, 400);
    const body = await parseJson(none);
    assert.ok((body.fields as Record<string, string>).project_id);
  });

  test("rejects malformed JSON and non-object bodies", async () => {
    const badJson = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(badJson.status, 400);
    const arrayBody = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[1,2,3]",
    });
    assert.equal(arrayBody.status, 400);
  });

  test("rejects empty PATCH body", async () => {
    const task = await createTask({ title: "stable" });
    const res = await app.request(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 400);
  });
});

describe("not found handling", () => {
  test("unknown project and task ids return 404", async () => {
    assert.equal((await app.request("/api/projects/999999")).status, 404);
    assert.equal((await app.request("/api/tasks/999999")).status, 404);
    assert.equal((await app.request("/api/projects/999999", { method: "PATCH", body: "{}" })).status, 404);
    assert.equal((await app.request("/api/tasks/999999", { method: "PATCH", body: "{}" })).status, 404);
    assert.equal((await app.request("/api/projects/999999", { method: "DELETE" })).status, 404);
    assert.equal((await app.request("/api/tasks/999999", { method: "DELETE" })).status, 404);
    assert.equal((await app.request("/api/unknown")).status, 404);
  });

  test("invalid method returns 404 with a JSON body", async () => {
    const res = await app.request("/api/tasks", { method: "PUT" });
    assert.equal(res.status, 404);
    const body = await parseJson(res);
    assert.equal(body.error, "Not found");
  });
});

describe("search and filter", () => {
  test("searches titles and descriptions", async () => {
    await createTask({ title: "Hiring pipeline review", description: "schedule interviews" });
    await createTask({ title: "Fix checkout bug", description: "nothing here" });
    const res = await app.request("/api/tasks?q=Hiring");
    const body = await parseJson(res);
    const titles = (body.tasks as Array<{ title: string }>).map((t) => t.title);
    assert.ok(titles.includes("Hiring pipeline review"));
    assert.ok(!titles.includes("Fix checkout bug"));
    const desc = await app.request("/api/tasks?q=interviews");
    const descBody = await parseJson(desc);
    assert.ok((descBody.tasks as Array<{ title: string }>).some((t) => t.title === "Hiring pipeline review"));
  });

  test("escapes LIKE wildcards in queries", async () => {
    await createTask({ title: "100% done milestone", description: "" });
    const res = await app.request(`/api/tasks?q=${encodeURIComponent("%")}`);
    const body = await parseJson(res);
    const tasks = body.tasks as Array<{ title: string }>;
    assert.ok(tasks.some((t) => t.title === "100% done milestone"));
    assert.ok(tasks.length > 0);
    assert.ok(tasks.every((t) => !t.title.includes("Hiring")));
  });

  test("filters by status and priority and combines them", async () => {
    await createTask({ title: "status done one", status: "done", priority: "high" });
    await createTask({ title: "status in_progress one", status: "in_progress", priority: "high" });
    const done = await parseJson(await app.request("/api/tasks?status=done"));
    const doneTasks = done.tasks as Array<{ status: string; title: string }>;
    assert.ok(doneTasks.length > 0);
    assert.ok(doneTasks.every((t) => t.status === "done"));
    assert.ok(doneTasks.some((t) => t.title === "status done one"));
    const highDone = await parseJson(await app.request("/api/tasks?status=done&priority=high&q=status"));
    const highDoneTasks = highDone.tasks as Array<{ title: string }>;
    assert.equal(highDoneTasks.length, 1);
    assert.equal(highDoneTasks[0]?.title, "status done one");
  });

  test("rejects an invalid status filter", async () => {
    const res = await app.request("/api/tasks?status=warp");
    assert.equal(res.status, 400);
  });
});

describe("schema, seed, and persistence", () => {
  test("seed data is idempotent across database opens", () => {
    const count = (d: Db, t: "project" | "task") =>
      Number((d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
    const fresh = openDb(dbPath);
    const counts = { projects: count(fresh, "project"), tasks: count(fresh, "task") };
    fresh.close();
    assert.ok(counts.projects >= 3);
    const second = openDb(dbPath);
    const counts2 = { projects: count(second, "project"), tasks: count(second, "task") };
    second.close();
    assert.deepEqual(counts2, counts);
  });

  test("migrate is idempotent", () => {
    const fresh = openDb(dbPath);
    fresh
      .prepare("INSERT INTO project (name, description, status) VALUES (?, ?, 'active')")
      .run("persist target", "proves restart persistence");
    const projId = Number((fresh.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
    fresh.close();

    const reopened = openDb(dbPath);
    const row = reopened.prepare("SELECT * FROM project WHERE id = ?").get(projId) as { name: string };
    reopened.close();
    assert.ok(row);
    assert.equal(row.name, "persist target");
  });

  test("database grows a non-empty file on disk", () => {
    const st = statSync(dbPath);
    assert.ok(st.size > 0);
  });
});