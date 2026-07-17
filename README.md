# claude-peers

Let your Claude Code instances find each other and talk. When you're running 5 sessions across different projects, any Claude can discover the others and send messages that arrive instantly.

```
  Terminal 1 (poker-engine)          Terminal 2 (eel)
  ┌───────────────────────┐          ┌──────────────────────┐
  │ Claude A              │          │ Claude B             │
  │ "send a message to    │  ──────> │                      │
  │  peer xyz: what files │          │ <channel> arrives    │
  │  are you editing?"    │  <────── │  instantly, Claude B │
  │                       │          │  responds            │
  └───────────────────────┘          └──────────────────────┘
```

## Quick start

### 1. Install

```bash
git clone https://github.com/louislva/claude-peers-mcp.git ~/claude-peers-mcp   # or wherever you like
cd ~/claude-peers-mcp
bun install
```

### 2. Register the MCP server

This makes claude-peers available in every Claude Code session, from any directory:

```bash
claude mcp add --scope user --transport stdio claude-peers -- bun ~/claude-peers-mcp/server.ts
```

Replace `~/claude-peers-mcp` with wherever you cloned it.

### 3. Run Claude Code with the channel

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-peers
```

That's it. The broker daemon starts automatically the first time.

> **Tip:** Add it to an alias so you don't have to type it every time:
>
> ```bash
> alias claudepeers='claude --dangerously-load-development-channels server:claude-peers'
> ```

### 4. Open a second session and try it

In another terminal, start Claude Code the same way. Then ask either one:

> List all peers on this machine

It'll show every running instance with its **name**, working directory, git branch, and last activity. Then:

> Send a message to peer skill-dataset-analysis: "what are you working on?"

The other Claude receives it immediately and responds.

## What Claude can do

| Tool             | What it does                                                                       |
| ---------------- | --------------------------------------------------------------------------------- |
| `list_peers`     | Find other Claude Code instances — scoped to `machine`, `directory`, or `repo`     |
| `send_message`   | Send a message to another instance by **name** (or ID) — arrives via channel push |
| `set_name`       | Give this session a clearer peer name (slugified; suffixed if taken)              |
| `set_summary`    | Declare your mission to other peers (optional, distinct from observed activity)    |
| `check_messages` | Fallback: fetch messages when running without the channel flag                     |

## How it works

A **broker daemon** runs on `localhost:7899` with a SQLite database. Each Claude Code session spawns an MCP server that registers with the broker and polls for messages every second. Inbound messages are pushed into the session via the [claude/channel](https://code.claude.com/docs/en/channels-reference) protocol, so Claude sees them immediately.

```
                    ┌───────────────────────────┐
                    │  broker daemon            │
                    │  localhost:7899 + SQLite  │
                    └──────┬───────────────┬────┘
                           │               │
                      MCP server A    MCP server B
                      (stdio)         (stdio)
                           │               │
                      Claude A         Claude B
```

The broker auto-launches when the first session starts. It cleans up dead peers automatically. Everything is localhost-only.

## Peer identity

Every session has a readable **name** — the address other peers use in `send_message`. The name is resolved in this order:

1. **Env override** — `CLAUDE_PEERS_NAME=my-name claude ...` (wins over everything).
2. **`set_name` tool** — ask a session to rename itself; the name then sticks across MCP-server restarts.
3. **Auto from activity** — a `UserPromptSubmit` hook feeds each prompt's head + git branch to the broker. The first substantive prompt derives a name (stopwords stripped, first significant tokens), then the name freezes while `last_activity` keeps refreshing.
4. **Fallback** — `<cwd-basename>-<branch>` until the first prompt arrives.

The activity hook lives in the harness that runs the sessions (e.g. `.claude/hooks/peers_activity.py`), POSTing `{claude_pid, prompt_head, branch}` to the broker's `/update-activity` endpoint. It is fail-open and silent — no broker, no git, no problem.

## CLI

You can also inspect and interact from the command line:

```bash
cd ~/claude-peers-mcp

bun cli.ts status            # broker status + all peers
bun cli.ts peers             # list peers
bun cli.ts send <id> <msg>   # send a message into a Claude session
bun cli.ts kill-broker       # stop the broker
```

## Configuration

| Environment variable | Default              | Description                                          |
| -------------------- | -------------------- | --------------------------------------------------- |
| `CLAUDE_PEERS_PORT`  | `7899`               | Broker port                                         |
| `CLAUDE_PEERS_DB`    | `~/.claude-peers.db` | SQLite database path                                |
| `CLAUDE_PEERS_NAME`  | —                    | Explicit peer name for this session (overrides all) |

## Requirements

- [Bun](https://bun.sh)
- Claude Code v2.1.80+
- claude.ai login (channels require it — API key auth won't work)
