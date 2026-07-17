import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

const PORT = 17898;
let brokerProc: ReturnType<typeof Bun.spawn>;
let clientA: Client;
let clientB: Client;

let nextClaudePid = 900_000;

async function makeClient(name: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [join(import.meta.dir, "server.ts")],
    env: {
      ...process.env,
      CLAUDE_PEERS_PORT: String(PORT),
      CLAUDE_PEERS_NAME: name,
      // Both server.ts instances are spawned as direct children of this test process, so they'd
      // otherwise share process.ppid and collide under the broker's claude_pid re-registration
      // dedup (silently evicting one peer -- see server.ts CLAUDE_PEERS_CLAUDE_PID comment).
      // Real sessions each have a distinct ppid (the `claude` CLI process), so this override is
      // test-only.
      CLAUDE_PEERS_CLAUDE_PID: String(nextClaudePid++),
    },
  });
  const client = new Client({ name: `test-${name}`, version: "0.0.1" });
  await client.connect(transport);
  return client;
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "peers-srv-test-"));
  brokerProc = Bun.spawn(["bun", join(import.meta.dir, "broker.ts")], {
    env: { ...process.env, CLAUDE_PEERS_PORT: String(PORT), CLAUDE_PEERS_DB: join(dir, "t.db") },
    stdio: ["ignore", "ignore", "ignore"],
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  clientA = await makeClient("peer-alpha");
  clientB = await makeClient("peer-beta");
  // wait for both servers to register with the broker
  await new Promise((r) => setTimeout(r, 1500));
});

afterAll(async () => {
  await clientA?.close();
  await clientB?.close();
  brokerProc.kill();
});

test("tool surface includes set_name", async () => {
  const tools = await clientA.listTools();
  const names = tools.tools.map((t) => t.name);
  expect(names).toContain("set_name");
  expect(names).toContain("send_message");
  expect(names).toContain("list_peers");
});

test("list_peers shows the other peer by name", async () => {
  const res = await clientA.callTool({ name: "list_peers", arguments: { scope: "machine" } });
  const text = (res.content as { type: string; text: string }[])[0].text;
  expect(text).toContain("peer-beta");
});

test(
  "send_message by name delivers a channel notification with from meta",
  async () => {
    const received = new Promise<{ content: string; meta: Record<string, string> }>((resolve) => {
      clientB.setNotificationHandler(
        z.object({
          method: z.literal("notifications/claude/channel"),
          params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }).passthrough(),
        }),
        async (n) => resolve(n.params as { content: string; meta: Record<string, string> }),
      );
    });

    const send = await clientA.callTool({
      name: "send_message",
      arguments: { to: "peer-beta", message: "field feedback: hint R3 misfires on EAV" },
    });
    expect((send.content as { text: string }[])[0].text).toContain("peer-beta");

    const msg = await Promise.race([
      received,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no notification within 8s")), 8000)),
    ]);
    expect(msg.content).toBe("field feedback: hint R3 misfires on EAV");
    expect(msg.meta.from).toBe("peer-alpha");
    expect(msg.meta.from_id).toHaveLength(8);
  },
  10000,
);

test("set_name renames and the new name is addressable", async () => {
  const r = await clientB.callTool({ name: "set_name", arguments: { name: "Skill Owner" } });
  expect((r.content as { text: string }[])[0].text).toContain("skill-owner");
  const send = await clientA.callTool({
    name: "send_message",
    arguments: { to: "skill-owner", message: "ping after rename" },
  });
  expect((send.content as { text: string }[])[0].text).toContain("skill-owner");
});

test("check_messages fallback returns sender name", async () => {
  // clientA has no notification handler registered; its messages accumulate in the buffer
  await clientB.callTool({
    name: "send_message",
    arguments: { to: "peer-alpha", message: "reply for the buffer" },
  });
  await new Promise((r) => setTimeout(r, 1500)); // let A's poll loop pick it up
  const res = await clientA.callTool({ name: "check_messages", arguments: {} });
  const text = (res.content as { text: string }[])[0].text;
  expect(text).toContain("reply for the buffer");
  expect(text).toContain("skill-owner");
});
