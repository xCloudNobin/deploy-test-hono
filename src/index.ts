import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { createApp } from "./app.js";
import { defaultConfig } from "./config.js";
import { openDb, type Db } from "./db.js";

const config = defaultConfig();

let db: Db | null = null;
try {
  db = openDb(config.dbPath);
} catch (err) {
  console.error(
    `[taskboard] FATAL: could not open database at ${config.dbPath}; ` +
      `serving liveness only, readiness and API routes will report 503. ` +
      `${err instanceof Error ? err.message : String(err)}`,
  );
}

const app = createApp({ config, db });

let server: ServerType;
try {
  server = serve({ fetch: app.fetch, port: config.port, hostname: config.bind });
} catch (err) {
  console.error(
    `[taskboard] FATAL: could not bind ${config.bind}:${config.port}: ${err instanceof Error ? err.message : String(err)}`,
  );
  db?.close();
  process.exit(1);
}

console.log(
  `[taskboard] serving ${config.buildMarker} (node ${process.version}, hono) at http://${config.bind}:${config.port}`,
);

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[taskboard] received ${signal}, shutting down cleanly`);
  const finish = (): void => {
    try {
      db?.close();
    } catch (err) {
      console.error("[taskboard] error closing database:", err);
    }
    process.exit(0);
  };
  try {
    server.close(finish);
  } catch {
    finish();
  }
  setTimeout(finish, 3000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  console.error("[taskboard] unhandledRejection:", reason);
});