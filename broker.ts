#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  Peer,
  Message,
} from "./shared/types.ts";
import { deriveNameFromPrompt, slugify } from "./shared/naming.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

function fallbackName(cwd: string, branch: string | null): string {
  const base = slugify(cwd.split("/").filter(Boolean).pop() ?? "peer") || "peer";
  const b = branch ? slugify(branch) : "";
  return b ? `${base}-${b}`.slice(0, 40).replace(/-+$/g, "") : base;
}

function uniquifyName(base: string, excludeId?: string): string {
  const rows = excludeId
    ? (db.query("SELECT name FROM peers WHERE name IS NOT NULL AND id != ?").all(excludeId) as { name: string }[])
    : (db.query("SELECT name FROM peers WHERE name IS NOT NULL").all() as { name: string }[]);
  const taken = new Set(rows.map((r) => r.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// --- v2 migration (idempotent) ---

function ensureColumn(table: string, col: string, decl: string) {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  }
}

ensureColumn("peers", "name", "TEXT");
ensureColumn("peers", "name_source", "TEXT NOT NULL DEFAULT 'auto'");
ensureColumn("peers", "name_is_fallback", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("peers", "claude_pid", "INTEGER");
ensureColumn("peers", "branch", "TEXT");
ensureColumn("peers", "last_activity", "TEXT");
ensureColumn("peers", "activity_at", "TEXT");
ensureColumn("messages", "from_name", "TEXT");
ensureColumn("messages", "from_cwd", "TEXT");
db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_peers_name ON peers(name)");

// Backfill names for rows registered by v1 servers before this migration ran
for (const row of db.query("SELECT id, cwd FROM peers WHERE name IS NULL").all() as { id: string; cwd: string }[]) {
  db.run("UPDATE peers SET name = ? WHERE id = ?", [uniquifyName(fallbackName(row.cwd, null)), row.id]);
}

// Clean up stale peers (PIDs that no longer exist) on startup
function cleanStalePeers() {
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  for (const peer of peers) {
    try {
      // Check if process is still alive (signal 0 doesn't kill, just checks)
      process.kill(peer.pid, 0);
    } catch {
      // Process doesn't exist, remove it
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
    }
  }
}

cleanStalePeers();

// Periodically clean stale peers (every 30s)
setInterval(cleanStalePeers, 30_000);

// --- Prepared statements ---

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

const selectAllPeers = db.prepare(`
  SELECT * FROM peers
`);

const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ?
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ?
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();

  // Re-registration dedup: key on claude_pid (stable per-session id) when the caller
  // provides one, since multiple peers can share the broker-subprocess `pid` (e.g. a
  // wrapper script); fall back to `pid` alone for legacy v1 callers with no claude_pid.
  const existing =
    body.claude_pid != null
      ? (db.query("SELECT id, name, name_source, name_is_fallback FROM peers WHERE claude_pid = ?").get(body.claude_pid) as
          { id: string; name: string; name_source: string; name_is_fallback: number } | null)
      : (db.query("SELECT id, name, name_source, name_is_fallback FROM peers WHERE pid = ? AND claude_pid IS NULL").get(body.pid) as
          { id: string; name: string; name_source: string; name_is_fallback: number } | null);
  if (existing) {
    deletePeer.run(existing.id);
  }

  const envName = body.name ? slugify(body.name) : "";
  let name: string;
  let nameSource: string;
  let nameIsFallback: number;
  if (envName) {
    name = uniquifyName(envName);
    nameSource = "env";
    nameIsFallback = 0;
  } else if (existing && existing.name && existing.name_is_fallback === 0) {
    name = uniquifyName(existing.name);
    nameSource = existing.name_source;
    nameIsFallback = 0;
  } else {
    name = uniquifyName(fallbackName(body.cwd, body.branch ?? null));
    nameSource = "auto";
    nameIsFallback = 1;
  }

  db.run(
    `INSERT INTO peers (id, pid, cwd, git_root, tty, summary, registered_at, last_seen,
                        name, name_source, name_is_fallback, claude_pid, branch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, body.pid, body.cwd, body.git_root, body.tty, body.summary, now, now,
     name, nameSource, nameIsFallback, body.claude_pid ?? null, body.branch ?? null],
  );
  return { id, name };
}

function handleUpdateActivity(body: { claude_pid: number; prompt_head: string; branch: string | null }): void {
  const peer = db
    .query("SELECT id, name_is_fallback FROM peers WHERE claude_pid = ? ORDER BY registered_at DESC")
    .get(body.claude_pid) as { id: string; name_is_fallback: number } | null;
  if (!peer) return; // no-op: unknown or flagless-era session
  const now = new Date().toISOString();
  db.run(
    "UPDATE peers SET last_activity = ?, activity_at = ?, branch = COALESCE(?, branch), last_seen = ? WHERE id = ?",
    [body.prompt_head, now, body.branch, now, peer.id],
  );
  if (peer.name_is_fallback === 1) {
    const derived = deriveNameFromPrompt(body.prompt_head);
    if (derived) {
      db.run("UPDATE peers SET name = ?, name_is_fallback = 0 WHERE id = ?", [uniquifyName(derived, peer.id), peer.id]);
    }
  }
}

function handleSetName(body: { id: string; name: string }): { ok: boolean; name?: string; error?: string } {
  const peer = db.query("SELECT id FROM peers WHERE id = ?").get(body.id) as { id: string } | null;
  if (!peer) return { ok: false, error: `Peer ${body.id} not found` };
  const name = uniquifyName(slugify(body.name) || "peer", body.id);
  db.run("UPDATE peers SET name = ?, name_source = 'manual', name_is_fallback = 0 WHERE id = ?", [name, body.id]);
  return { ok: true, name };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "machine":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        // No git root, fall back to directory
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // Verify each peer's process is still alive
  return peers.filter((p) => {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      // Clean up dead peer
      deletePeer.run(p.id);
      return false;
    }
  });
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  const target = body.to ?? body.to_id;
  if (!target) return { ok: false, error: "Missing 'to' (peer name or ID)" };

  const byName = db.query("SELECT id FROM peers WHERE name = ?").get(target) as { id: string } | null;
  const byId = byName ? null : (db.query("SELECT id FROM peers WHERE id = ?").get(target) as { id: string } | null);
  const resolved = byName ?? byId;
  if (!resolved) {
    const names = (db.query("SELECT name FROM peers WHERE name IS NOT NULL").all() as { name: string }[])
      .map((r) => r.name)
      .join(", ");
    return { ok: false, error: `Peer "${target}" not found. Live peers: ${names || "(none)"}` };
  }

  const sender = db.query("SELECT name, cwd FROM peers WHERE id = ?").get(body.from_id) as
    | { name: string | null; cwd: string }
    | null;
  db.run(
    "INSERT INTO messages (from_id, to_id, text, sent_at, delivered, from_name, from_cwd) VALUES (?, ?, ?, ?, 0, ?, ?)",
    [body.from_id, resolved.id, body.text, new Date().toISOString(), sender?.name ?? null, sender?.cwd ?? null],
  );
  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];

  // Mark them as delivered
  for (const msg of messages) {
    markDelivered.run(msg.id);
  }

  return { messages };
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
}

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
      }
      return new Response("claude-peers broker", { status: 200 });
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          handleHeartbeat(body as HeartbeatRequest);
          return Response.json({ ok: true });
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/update-activity":
          handleUpdateActivity(body as { claude_pid: number; prompt_head: string; branch: string | null });
          return Response.json({ ok: true });
        case "/set-name":
          return Response.json(handleSetName(body as { id: string; name: string }));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(`[claude-peers broker] listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
