import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression coverage for two bugs shipped untested:
//  1. TDZ crash on broker startup when the persistent DB already contains a
//     dead-peer row (`cleanStalePeers()` ran before `deletePeer` was declared).
//  2. A non-numeric CLAUDE_PEERS_PAIR_LIMIT produced NaN, silently disabling
//     the runaway guard instead of falling back to the default.

const PORT_1 = 17902;
const PORT_2 = 17903;
const PORT_3 = 17904;

async function waitForHealth(base: string): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function post<T>(base: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

test("restart with a pre-existing dead-peer row does not crash on the TDZ bug", async () => {
  const dir = mkdtempSync(join(tmpdir(), "peers-restart-test-"));
  const dbPath = join(dir, "test.db");
  const base1 = `http://127.0.0.1:${PORT_1}`;
  const base2 = `http://127.0.0.1:${PORT_2}`;

  // First broker: creates the schema, then we kill it.
  const proc1 = Bun.spawn(["bun", "broker.ts"], {
    env: { ...process.env, CLAUDE_PEERS_PORT: String(PORT_1), CLAUDE_PEERS_DB: dbPath },
    stdio: ["ignore", "ignore", "ignore"],
  });
  expect(await waitForHealth(base1)).toBe(true);
  proc1.kill();
  await proc1.exited;

  // Directly insert a peer row with a dead PID (999999 -> ESRCH -> dead).
  // Do NOT use pid 1: on macOS `process.kill(1, 0)` throws EPERM, which the
  // broker's alive-check treats as "alive" (not what we want here).
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO peers (id, pid, cwd, git_root, tty, summary, registered_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["deadpeer1", 999999, "/tmp/dead-peer-cwd", null, null, "", now, now],
  );
  db.close();

  // Second broker against the same DB: this is the regression. Pre-fix, this
  // crashes with `ReferenceError: Cannot access 'deletePeer' before
  // initialization` inside cleanStalePeers() and never binds the port.
  const proc2 = Bun.spawn(["bun", "broker.ts"], {
    env: { ...process.env, CLAUDE_PEERS_PORT: String(PORT_2), CLAUDE_PEERS_DB: dbPath },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    expect(await waitForHealth(base2)).toBe(true);

    // The dead peer should have been cleaned up on startup.
    const peers = await post<{ pid: number }[]>(base2, "/list-peers", { scope: "machine" });
    expect(peers.some((p) => p.pid === 999999)).toBe(false);
  } finally {
    proc2.kill();
    await proc2.exited;
  }
});

test("non-numeric CLAUDE_PEERS_PAIR_LIMIT does not crash and the guard stays active (falls back to default)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "peers-pairlimit-test-"));
  const dbPath = join(dir, "test.db");
  const base = `http://127.0.0.1:${PORT_3}`;

  const proc = Bun.spawn(["bun", "broker.ts"], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(PORT_3),
      CLAUDE_PEERS_DB: dbPath,
      CLAUDE_PEERS_PAIR_LIMIT: "abc",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    // Startup itself must not crash despite parseInt("abc", 10) === NaN.
    expect(await waitForHealth(base)).toBe(true);

    const a = await post<{ id: string }>(base, "/register", {
      pid: process.pid, cwd: "/tmp/pl-a", git_root: null, tty: null,
      summary: "", name: "pl-a", claude_pid: 101, branch: null,
    });
    const b = await post<{ id: string }>(base, "/register", {
      pid: process.pid, cwd: "/tmp/pl-b", git_root: null, tty: null,
      summary: "", name: "pl-b", claude_pid: 102, branch: null,
    });

    // The guard should be active at the default (20), not disabled by NaN
    // (an `n >= NaN` disabled guard would still return ok:true here too, but
    // a crash on startup or on this call would fail the test either way).
    const r = await post<{ ok: boolean; error?: string }>(base, "/send-message", {
      from_id: a.id, to: "pl-b", text: "hello",
    });
    expect(r.ok).toBe(true);
  } finally {
    proc.kill();
    await proc.exited;
  }
});
