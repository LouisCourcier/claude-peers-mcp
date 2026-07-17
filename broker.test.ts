import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveNameFromPrompt, slugify } from "./shared/naming.ts";

const PORT = 17899;
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
  const dir = mkdtempSync(join(tmpdir(), "peers-test-"));
  brokerProc = Bun.spawn(["bun", "broker.ts"], {
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(PORT),
      CLAUDE_PEERS_DB: join(dir, "test.db"),
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
  test("deriveNameFromPrompt keeps 4 significant tokens", () => {
    expect(deriveNameFromPrompt("reprend le full scope urgewald stp")).toBe(
      "reprend-full-scope-urgewald",
    );
  });
  test("deriveNameFromPrompt returns null on weak prompts", () => {
    expect(deriveNameFromPrompt("tout est bon ?")).toBeNull();
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

  test("update-activity refreshes activity and upgrades a fallback name once", async () => {
    await post("/update-activity", {
      claude_pid: 222,
      prompt_head: "analyse complete du provider bloomberg datasets bnpp",
      branch: "feat/tagging-v2",
    });
    let peers = await post<any[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null });
    let p = peers.find((x) => x.claude_pid === 222);
    expect(p.name).toBe("analyse-complete-provider-bloomberg");
    expect(p.last_activity).toBe("analyse complete du provider bloomberg datasets bnpp");
    // second update must NOT rename (frozen), only refresh activity
    await post("/update-activity", {
      claude_pid: 222, prompt_head: "maintenant corrige le connecteur trucost edx stp", branch: "main",
    });
    peers = await post<any[]>("/list-peers", { scope: "machine", cwd: "/", git_root: null });
    p = peers.find((x) => x.claude_pid === 222);
    expect(p.name).toBe("analyse-complete-provider-bloomberg");
    expect(p.branch).toBe("main");
    expect(p.last_activity).toContain("corrige le connecteur");
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
});
