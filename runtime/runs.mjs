import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const runColumns = `
  run_id, session_id, cwd, model, status, started_at, finished_at,
  cancel_requested, credits, error
`;

export function summarizeRun({ cancel_requested, credits, error, ...run }) {
  return {
    ...run,
    status: run.status === "running" && cancel_requested ? "cancelling" : run.status,
    ...(credits !== null ? { credits } : {}),
    ...(error ? { error } : {}),
  };
}

export function openRuns(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, model TEXT NOT NULL,
      session_id TEXT, status TEXT NOT NULL, owner_pid INTEGER NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
      credits REAL, answer TEXT, error TEXT, steps TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_turn_per_session ON runs(session_id)
      WHERE session_id IS NOT NULL AND status = 'running';
  `);

  const insert = db.prepare(`
    INSERT INTO runs (run_id, cwd, model, session_id, status, owner_pid, started_at)
    VALUES (?, ?, ?, ?, 'running', ?, ?)
    ON CONFLICT(session_id) WHERE session_id IS NOT NULL AND status = 'running' DO NOTHING
  `);
  const read = db.prepare(`SELECT ${runColumns} FROM runs WHERE run_id = ?`);
  const readDetails = db.prepare(`SELECT ${runColumns}, steps, answer FROM runs WHERE run_id = ?`);
  const recent = db.prepare(`
    SELECT ${runColumns} FROM runs
    ORDER BY (status = 'running') DESC, started_at DESC, run_id
    LIMIT ? OFFSET ?
  `);
  const runningOwners = db.prepare("SELECT run_id, owner_pid FROM runs WHERE status = 'running'");
  const saveSession = db.prepare("UPDATE runs SET session_id = ? WHERE run_id = ?");
  const saveSteps = db.prepare("UPDATE runs SET steps = ? WHERE run_id = ?");
  const readCancel = db.prepare("SELECT cancel_requested FROM runs WHERE run_id = ?");
  const markCancel = db.prepare(`
    UPDATE runs SET cancel_requested = 1
    WHERE run_id = ? AND status = 'running' AND cancel_requested = 0
  `);
  const finish = db.prepare(`
    UPDATE runs SET status = ?, finished_at = ?, credits = ?, answer = ?, error = ?
    WHERE run_id = ? AND status = 'running'
  `);

  return {
    begin(cwd, model, sessionId) {
      const id = randomUUID();
      const result = insert.run(id, cwd, model, sessionId ?? null, process.pid, new Date().toISOString());
      if (!result.changes) {
        throw new Error("This Qoder session already has an active turn. Wait for it or cancel it before following up.");
      }
      return id;
    },
    get: id => read.get(id),
    getDetails: id => readDetails.get(id),
    recent: (limit, offset) => recent.all(limit, offset),
    saveSession: (id, sessionId) => saveSession.run(sessionId, id),
    saveSteps: (id, steps) => saveSteps.run(JSON.stringify(steps), id),
    cancelRequested: id => readCancel.get(id)?.cancel_requested === 1,
    requestCancel: id => markCancel.run(id),
    finish(id, { status, credits = null, answer = null, error = null }) {
      finish.run(status, new Date().toISOString(), credits, answer, error, id);
    },
    recoverDisconnected() {
      for (const { run_id, owner_pid } of runningOwners.all()) {
        if (owner_pid === process.pid) continue;
        try {
          process.kill(owner_pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") {
            finish.run("disconnected", new Date().toISOString(), null, null,
              "The MCP process exited before reporting a final result.", run_id);
          }
        }
      }
    },
  };
}
