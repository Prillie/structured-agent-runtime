import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  contextSchema,
  type Context,
  type Run,
  type Review,
} from "./contracts.js";

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** SQLite owns approval transitions and the local outbox in a single transaction. */
export class Store {
  private readonly db: DatabaseSync;
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS contexts (workspace TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (workspace TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(workspace, id));
      CREATE TABLE IF NOT EXISTS outbox (workspace TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, reviewer TEXT NOT NULL, PRIMARY KEY(workspace, id));
    `);
  }
  close(): void {
    this.db.close();
  }
  context(workspace: string): Context {
    const row = this.db
      .prepare("SELECT data FROM contexts WHERE workspace = ?")
      .get(workspace);
    return row
      ? contextSchema.parse(JSON.parse(String(row.data)))
      : { version: 0, notes: [] };
  }
  find(workspace: string, id: string): Run | undefined {
    const row = this.db
      .prepare("SELECT data FROM runs WHERE workspace = ? AND id = ?")
      .get(workspace, id);
    return row ? (JSON.parse(String(row.data)) as Run) : undefined;
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private put(run: Run): void {
    this.db
      .prepare(
        "INSERT INTO runs VALUES (?, ?, ?) ON CONFLICT(workspace, id) DO UPDATE SET data = excluded.data",
      )
      .run(run.request.workspace, run.request.id, JSON.stringify(run));
  }
  private appendContext(run: Run): void {
    const context = this.context(run.request.workspace);
    const next = contextSchema.parse({
      version: context.version + 1,
      notes: [...context.notes, run.output.summary].slice(-20),
    });
    this.db
      .prepare(
        "INSERT INTO contexts VALUES (?, ?) ON CONFLICT(workspace) DO UPDATE SET data = excluded.data",
      )
      .run(run.request.workspace, JSON.stringify(next));
  }
  save(run: Run): Run {
    return this.transaction(() => {
      const existing = this.find(run.request.workspace, run.request.id);
      if (existing) {
        if (existing.fingerprint !== run.fingerprint)
          throw new Error("Request ID reused with different input");
        return existing;
      }
      this.put(run);
      if (run.status === "complete") this.appendContext(run);
      return run;
    });
  }
  review(review: Review, principal: string, now: number): Run {
    return this.transaction(() => {
      const run = this.find(review.workspace, review.requestId);
      if (!run || run.status !== "pending")
        throw new Error("No pending action");
      if (run.expiresAt <= now)
        throw new Error("Approval expired; create a new request");
      if (run.digest !== review.digest || digest(run.output) !== review.digest)
        throw new Error("Approval does not match proposal");
      run.status = review.decision === "approve" ? "approved" : "rejected";
      if (review.decision === "approve") {
        if (!run.output.action) throw new Error("No action to approve");
        // Approval promotes both the action and its summary in this transaction.
        this.db
          .prepare("INSERT INTO outbox VALUES (?, ?, ?, ?)")
          .run(
            review.workspace,
            review.requestId,
            JSON.stringify(run.output.action),
            principal,
          );
        this.appendContext(run);
      }
      this.put(run);
      return run;
    });
  }
  tickets(workspace: string): unknown[] {
    return this.db
      .prepare(
        "SELECT id, data, reviewer FROM outbox WHERE workspace = ? ORDER BY id",
      )
      .all(workspace)
      .map((row) => ({
        id: row.id,
        action: JSON.parse(String(row.data)) as unknown,
        reviewer: row.reviewer,
      }));
  }
}
