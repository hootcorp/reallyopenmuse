import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { createDemoModel, demoModel } from "../apps/server/src/demo/model.ts";
import { Agent, fetchTransport } from "../packages/agui/src/index.ts";

let db: Store, directory: string;
const closers: (() => Promise<void> | void)[] = [];
const baseConfig = (): Config => ({
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir: directory,
  agentBackend: "sample",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
});

async function start(config: Config) {
  const { app } = await createApp(db, config);
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  closers.push(() => {
    (server as Server).closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const { token } = (await session.json()) as { token: string };
  return { app, base, token };
}
const agentFor = (base: string, token: string) =>
  new Agent({
    url: `${base}/api/agui/run`,
    threadId: "runtime-thread",
    headers: () => ({ Authorization: `Bearer ${token}` }),
    transport: fetchTransport,
  });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-agui-"));
  db = await createStore();
});
after(async () => {
  for (const close of closers) await close();
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("the run endpoint needs a session and a valid AG-UI input", async () => {
  const { base, token } = await start(baseConfig());
  const anonymous = await fetch(`${base}/api/agui/run`, { method: "POST", body: "{}" });
  assert.equal(anonymous.status, 401);
  const invalid = await fetch(`${base}/api/agui/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messages: "nope" }),
  });
  assert.equal(invalid.status, 422);
});

test("the client streams a sample-agent reply end to end over HTTP", async () => {
  const { base, token } = await start(baseConfig());
  const info = await fetch(`${base}/api/agui/info`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(info.status, 200);
  const response = await fetch(`${base}/api/agui/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: "t",
      runId: "r",
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
      messages: [{ id: "u1", role: "user", content: "Show my calendar" }],
    }),
  });
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const stream = await response.text();
  assert.match(stream, /"type":"RUN_STARTED"/);
  assert.match(stream, /"type":"TEXT_MESSAGE_CONTENT"/);
  assert.match(stream, /"type":"RUN_FINISHED"/);

  const agent = agentFor(base, token);
  agent.addMessage({ id: "u2", role: "user", content: "Complete the permission slip" });
  await agent.run();
  const assistant = agent.messages.filter((m) => m.role === "assistant");
  assert.ok(assistant.length >= 1);
  const delegated = assistant.find((m) => m.role === "assistant" && m.toolCalls?.length);
  assert.equal(
    delegated?.role === "assistant" && delegated.toolCalls?.[0].function.name,
    "delegate_task",
  );
  assert.ok(agent.messages.some((m) => m.role === "tool"));
});

test("a model-backed run without a provider key explains how to configure chat", async () => {
  const saved = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  };
  for (const key of Object.keys(saved)) delete process.env[key];
  try {
    const { base, token } = await start({
      ...baseConfig(),
      agentBackend: "model",
      model: "openai/gpt-5",
    });
    await assert.rejects(agentFor(base, token).run(), /Configure a model and provider API key/);
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test("the built-in model agent streams through the scripted local model", async () => {
  const mock = createDemoModel({ latency: 0, firstByteDelay: 0 });
  await mock.start();
  closers.push(() => mock.stop());
  const saved = { base: process.env.OPENAI_BASE_URL, key: process.env.OPENAI_API_KEY };
  process.env.OPENAI_BASE_URL = `${mock.url}/v1`;
  process.env.OPENAI_API_KEY = "local-test-only";
  try {
    const { base, token } = await start({
      ...baseConfig(),
      agentBackend: "model",
      model: demoModel,
    });
    const agent = agentFor(base, token);
    agent.addMessage({ id: "u1", role: "user", content: "Hello there" });
    await agent.run();
    const reply = agent.messages.at(-1);
    assert.ok(reply?.role === "assistant");
    assert.match(reply.content ?? "", /Try “Find cool stuff on Hacker News”/);
    assert.equal(mock.getRequests().length, 1);
  } finally {
    if (saved.base === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = saved.base;
    if (saved.key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.key;
  }
});

test("closing the request stops a run and the server keeps serving", async () => {
  const mock = createDemoModel({ latency: 50, firstByteDelay: 0 });
  await mock.start();
  closers.push(() => mock.stop());
  const saved = { base: process.env.OPENAI_BASE_URL, key: process.env.OPENAI_API_KEY };
  process.env.OPENAI_BASE_URL = `${mock.url}/v1`;
  process.env.OPENAI_API_KEY = "local-test-only";
  try {
    const { base, token } = await start({
      ...baseConfig(),
      agentBackend: "model",
      model: demoModel,
    });
    const agent = agentFor(base, token);
    agent.addMessage({ id: "u1", role: "user", content: "Hello there" });
    const running = agent.run();
    while (!agent.messages.some((m) => m.role === "assistant"))
      await new Promise((resolve) => setTimeout(resolve, 10));
    agent.stop();
    await running;
    assert.equal(agent.isRunning, false);
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
  } finally {
    if (saved.base === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = saved.base;
    if (saved.key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.key;
  }
});
