import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slugify } from "./shared/naming.ts";

const PORT = 17899;
const BASE = `http://127.0.0.1:${PORT}`;
let brokerProc: ReturnType<typeof Bun.spawn>;
let dbPath: string;

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "peers-test-"));
  dbPath = join(dir, "test.db");
  brokerProc = Bun.spawn(["bun", "broker.ts"], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(PORT),
      CLAUDE_PEERS_DB: dbPath,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("broker did not start");
});

afterAll(() => {
  brokerProc.kill();
});

describe("naming", () => {
  test("slugify strips accents and symbols", () => {
    expect(slugify("Créé pour l'Analyse #2")).toBe("cree-pour-l-analyse-2");
  });
  test("slugify caps at 40 chars without trailing hyphen", () => {
    const s = slugify("a".repeat(38) + " bcd");
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith("-")).toBe(false);
  });
});

describe("broker identity", () => {
  test("register with env name slugs it and returns it", async () => {
    const r = await post<{ id: string; name: string }>("/register", {
      pid: process.pid, cwd: "/tmp/x", git_root: null, tty: null,
      summary: "", name: "Skill Dataset Analysis", claude_pid: 111, branch: "main",
    });
    expect(r.name).toBe("skill-dataset-analysis");
  });

  test("register without name falls back to cwd-branch slug", async () => {
    const r = await post<{ id: string; name: string }>("/register", {
      pid: process.pid, cwd: "/Users/x/Documents/Repo", git_root: null,
      tty: null, summary: "", claude_pid: 222, branch: "feat/tagging-v2",
    });
    expect(r.name).toBe("repo-feat-tagging-v2");
  });

  test("name collision gets a numeric suffix", async () => {
    const r = await post<{ id: string; name: string }>("/register", {
      pid: process.pid, cwd: "/tmp/y", git_root: null, tty: null,
      summary: "", name: "skill dataset analysis", claude_pid: 333, branch: null,
    });
    expect(r.name).toBe("skill-dataset-analysis-2");
  });

  test("legacy v1 register (no name/claude_pid/branch) still works", async () => {
    const r = await post<{ id: string; name: string }>("/register", {
      pid: process.pid, cwd: "/tmp/legacy", git_root: null, tty: null, summary: "",
    });
    expect(r.id).toHaveLength(8);
    expect(r.name).toBe("legacy");
  });

  test("update-activity refreshes activity but never renames", async () => {
    await post("/update-activity", {
      claude_pid: 222,
      prompt_head: "analyse complete du provider bloomberg datasets bnpp",
      branch: "feat/tagging-v2",
    });
    const peers = await post<any[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null });
    const p = peers.find((x) => x.claude_pid === 222);
    expect(p.name).toBe("repo-feat-tagging-v2");
    expect(p.last_activity).toBe("analyse complete du provider bloomberg datasets bnpp");
  });

  test("update-activity for unknown claude_pid is a 200 no-op", async () => {
    const res = await fetch(`${BASE}/update-activity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claude_pid: 99999, prompt_head: "x", branch: null }),
    });
    expect(res.ok).toBe(true);
  });

  test("set-name renames with slug + uniquify and freezes", async () => {
    const reg = await post<{ id: string; name: string }>("/register", {
      pid: process.pid, cwd: "/tmp/z", git_root: null, tty: null,
      summary: "", claude_pid: 444, branch: null,
    });
    const r = await post<{ ok: boolean; name: string }>("/set-name", {
      id: reg.id, name: "Skill Dataset Analysis",
    });
    expect(r.name).toBe("skill-dataset-analysis-3");
  });

  test("set-name to a peer's own current slug is a no-op (no self-collision)", async () => {
    const reg = await post<{ id: string; name: string }>("/register", {
      pid: process.pid, cwd: "/tmp/self", git_root: null, tty: null,
      summary: "", name: "self-slug", claude_pid: 777, branch: null,
    });
    expect(reg.name).toBe("self-slug");
    const r = await post<{ ok: boolean; name: string }>("/set-name", {
      id: reg.id, name: "self-slug",
    });
    expect(r.name).toBe("self-slug");
  });

  test("register preserves a peer's non-fallback name across re-registration (server restart)", async () => {
    const first = await post<{ id: string; name: string }>("/register", {
      pid: process.pid, cwd: "/tmp/restart", git_root: null, tty: null,
      summary: "", claude_pid: 888, branch: "main",
    });
    await post("/set-name", { id: first.id, name: "kept-name" });
    const second = await post<{ id: string; name: string }>("/register", {
      pid: process.pid, cwd: "/tmp/restart", git_root: null, tty: null,
      summary: "", claude_pid: 888, branch: "main",
    });
    expect(second.name).toBe("kept-name");
    const peers = await post<any[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null });
    const p = peers.find((x) => x.claude_pid === 888);
    expect(p.name).toBe("kept-name");
    expect(p.name_is_fallback).toBe(0);
  });

  test("register with a fallback name re-registering on a changed branch still updates the fallback name", async () => {
    const first = await post<{ id: string; name: string }>("/register", {
      pid: process.pid, cwd: "/tmp/branchy", git_root: null, tty: null,
      summary: "", claude_pid: 999, branch: "feat/one",
    });
    expect(first.name).toBe("branchy-feat-one");
    const second = await post<{ id: string; name: string }>("/register", {
      pid: process.pid, cwd: "/tmp/branchy", git_root: null, tty: null,
      summary: "", claude_pid: 999, branch: "feat/two",
    });
    expect(second.name).toBe("branchy-feat-two");
  });
});

describe("broker messaging", () => {
  test("send by NAME resolves and snapshots sender identity", async () => {
    const a = await post<{ id: string; name: string }>("/register", {
      pid: process.pid, cwd: "/tmp/a", git_root: null, tty: null,
      summary: "", name: "sender-a", claude_pid: 555, branch: null,
    });
    const b = await post<{ id: string; name: string }>("/register", {
      pid: process.pid, cwd: "/tmp/b", git_root: null, tty: null,
      summary: "", name: "receiver-b", claude_pid: 666, branch: null,
    });
    const s = await post<{ ok: boolean }>("/send-message", {
      from_id: a.id, to: "receiver-b", text: "hello by name",
    });
    expect(s.ok).toBe(true);
    const polled = await post<{ messages: any[] }>("/poll-messages", { id: b.id });
    expect(polled.messages).toHaveLength(1);
    expect(polled.messages[0].text).toBe("hello by name");
    expect(polled.messages[0].from_name).toBe("sender-a");
    expect(polled.messages[0].from_cwd).toBe("/tmp/a");
    // delivered: second poll is empty
    const again = await post<{ messages: any[] }>("/poll-messages", { id: b.id });
    expect(again.messages).toHaveLength(0);
  });

  test("send by ID and legacy to_id still work", async () => {
    const peers = await post<any[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null });
    const a = peers.find((p) => p.name === "sender-a");
    const b = peers.find((p) => p.name === "receiver-b");
    expect((await post<{ ok: boolean }>("/send-message", { from_id: a.id, to: b.id, text: "by id" })).ok).toBe(true);
    expect((await post<{ ok: boolean }>("/send-message", { from_id: a.id, to_id: b.id, text: "legacy" })).ok).toBe(true);
    const polled = await post<{ messages: any[] }>("/poll-messages", { id: b.id });
    expect(polled.messages).toHaveLength(2);
  });

  test("unknown target error lists live peer names", async () => {
    const peers = await post<any[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null });
    const a = peers.find((p) => p.name === "sender-a");
    const r = await post<{ ok: boolean; error?: string }>("/send-message", {
      from_id: a.id, to: "nobody-here", text: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("receiver-b");
  });

  test("delivery receipt: buffered until polled, delivered after", async () => {
    const peers = await post<any[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null });
    const a = peers.find((p) => p.name === "sender-a");
    const b = peers.find((p) => p.name === "receiver-b");
    const s = await post<{ ok: boolean; id: number }>("/send-message", {
      from_id: a.id, to: "receiver-b", text: "receipt test",
    });
    expect(s.ok).toBe(true);
    expect(s.id).toBeGreaterThan(0);
    let st = await post<{ ok: boolean; status: string }>("/message-status", { id: s.id });
    expect(st.status).toBe("buffered");
    await post("/poll-messages", { id: b.id });
    st = await post<{ ok: boolean; status: string; delivered_at: string }>("/message-status", { id: s.id });
    expect(st.status).toBe("delivered");
    expect((st as any).delivered_at).toBeTruthy();
  });

  test("message-status on an unknown id is an explicit error", async () => {
    const r = await post<{ ok: boolean; error?: string }>("/message-status", { id: 999999 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not found");
  });
});

describe("living directory", () => {
  test("ring buffer keeps the 5 most recent substantive prompts, newest first", async () => {
    await post("/register", {
      pid: process.pid, cwd: "/tmp/ring", git_root: null, tty: null,
      summary: "", claude_pid: 1010, branch: "main",
    });
    for (let i = 1; i <= 7; i++) {
      await post("/update-activity", {
        claude_pid: 1010, prompt_head: `substantive prompt number ${i} padding`, branch: "main",
      });
    }
    await post("/update-activity", { claude_pid: 1010, prompt_head: "go", branch: "main" });
    const peers = await post<any[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null });
    const p = peers.find((x) => x.claude_pid === 1010);
    expect(p.recent_activity).toHaveLength(5);
    expect(p.recent_activity[0].prompt_head).toContain("number 7");
    expect(p.recent_activity[4].prompt_head).toContain("number 3");
    expect(p.last_activity).toBe("go");
  });

  test("unregister clears the peer's activity rows", async () => {
    const first = await post<{ id: string }>("/register", {
      pid: process.pid, cwd: "/tmp/wipe", git_root: null, tty: null,
      summary: "", claude_pid: 2020, branch: null,
    });
    await post("/update-activity", {
      claude_pid: 2020, prompt_head: "some substantive activity here", branch: null,
    });

    const db = new Database(dbPath, { readonly: true });
    const countForPeer = () =>
      (db.query("SELECT COUNT(*) AS n FROM peer_activity WHERE peer_id = ?").get(first.id) as { n: number }).n;
    expect(countForPeer()).toBe(1);

    await post("/unregister", { id: first.id });
    expect(countForPeer()).toBe(0);
    db.close();
  });
});
