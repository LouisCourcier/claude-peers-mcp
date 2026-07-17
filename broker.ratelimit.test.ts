import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 17901;
const BASE = `http://127.0.0.1:${PORT}`;
let brokerProc: ReturnType<typeof Bun.spawn>;

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "peers-rl-test-"));
  brokerProc = Bun.spawn(["bun", "broker.ts"], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(PORT),
      CLAUDE_PEERS_DB: join(dir, "test.db"),
      CLAUDE_PEERS_PAIR_LIMIT: "3",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("broker did not start");
});

afterAll(() => {
  brokerProc.kill();
});

test("pair limit blocks the 4th message in the window, counting both directions", async () => {
  const a = await post<{ id: string }>("/register", {
    pid: process.pid, cwd: "/tmp/rl-a", git_root: null, tty: null,
    summary: "", name: "rl-a", claude_pid: 1, branch: null,
  });
  const b = await post<{ id: string }>("/register", {
    pid: process.pid, cwd: "/tmp/rl-b", git_root: null, tty: null,
    summary: "", name: "rl-b", claude_pid: 2, branch: null,
  });
  expect((await post<{ ok: boolean }>("/send-message", { from_id: a.id, to: "rl-b", text: "1" })).ok).toBe(true);
  expect((await post<{ ok: boolean }>("/send-message", { from_id: b.id, to: "rl-a", text: "2" })).ok).toBe(true);
  expect((await post<{ ok: boolean }>("/send-message", { from_id: a.id, to: "rl-b", text: "3" })).ok).toBe(true);
  const r = await post<{ ok: boolean; error?: string }>("/send-message", {
    from_id: b.id, to: "rl-a", text: "4",
  });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("runaway guard");
  expect(r.error).toContain("CLAUDE_PEERS_PAIR_LIMIT");
});

test("a different pair is unaffected by the saturated one", async () => {
  const c = await post<{ id: string }>("/register", {
    pid: process.pid, cwd: "/tmp/rl-c", git_root: null, tty: null,
    summary: "", name: "rl-c", claude_pid: 3, branch: null,
  });
  const r = await post<{ ok: boolean }>("/send-message", { from_id: c.id, to: "rl-a", text: "cross" });
  expect(r.ok).toBe(true);
});
