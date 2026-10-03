import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

let db: Store, directory: string, token: string;
let app: Awaited<ReturnType<typeof createApp>>["app"];
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const get = (path: string) => app.request(path, { headers: headers() });
const send = (path: string, method: string, body: unknown) =>
  app.request(path, { method, headers: headers(), body: JSON.stringify(body) });
const user = (id: string, content: string) => ({ id, role: "user", content });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-threads-"));
  db = await createStore();
  ({ app } = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  }));
  const session = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  token = (await session.json()).token;
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("thread routes require a session", async () => {
  for (const [path, method] of [
    ["/api/threads", "GET"],
    ["/api/threads/a/messages", "GET"],
    ["/api/threads/a/messages", "PUT"],
    ["/api/threads/a", "PATCH"],
  ])
    assert.equal((await app.request(path, { method })).status, 401, `${method} ${path}`);
});

test("a side chat is created on first save, named from its first message and listed", async () => {
  assert.deepEqual(await (await get("/api/threads")).json(), { threads: [], nextCursor: null });
  const saved = await send("/api/threads/side-1/messages", "PUT", {
    messages: [user("m1", "Plan   the weekend trip\nwith the kids")],
  });
  assert.equal(saved.status, 200);
  const list = await (await get("/api/threads")).json();
  assert.equal(list.threads.length, 1);
  assert.equal(list.threads[0].id, "side-1");
  assert.equal(list.threads[0].name, "Plan the weekend trip with the kids");
  assert.equal(list.threads[0].archived, false);
  const history = await (await get("/api/threads/side-1/messages")).json();
  assert.equal(history.messages[0].content, "Plan   the weekend trip\nwith the kids");
  assert.deepEqual(await (await get("/api/threads/unknown/messages")).json(), { messages: [] });
});

test("history keeps assistant tool calls and tool results", async () => {
  const messages = [
    user("u1", "Read example.com"),
    {
      id: "a1",
      role: "assistant",
      content: "Reading it.",
      toolCalls: [
        { id: "t1", type: "function", function: { name: "browse_web", arguments: "{}" } },
      ],
    },
    { id: "r1", role: "tool", toolCallId: "t1", content: '{"title":"Example"}' },
  ];
  assert.equal((await send("/api/threads/side-tools/messages", "PUT", { messages })).status, 200);
  const history = await (await get("/api/threads/side-tools/messages")).json();
  assert.equal(history.messages[1].toolCalls[0].function.name, "browse_web");
  assert.equal(history.messages[2].toolCallId, "t1");
});

test("invalid ids and malformed messages are rejected without changing history", async () => {
  assert.equal(
    (await send("/api/threads/side-1/messages", "PUT", { messages: [{ role: "nope" }] })).status,
    422,
  );
  assert.equal((await send("/api/threads/bad%20id/messages", "PUT", { messages: [] })).status, 422);
  const history = await (await get("/api/threads/side-1/messages")).json();
  assert.equal(history.messages.length, 1);
});

test("rename and archive update the list; archived chats are hidden unless requested", async () => {
  const renamed = await send("/api/threads/side-1", "PATCH", { name: "Weekend" });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).name, "Weekend");
  assert.equal((await send("/api/threads/side-1", "PATCH", { archived: true })).status, 200);
  const active = await (await get("/api/threads")).json();
  assert.ok(active.threads.every((thread: { id: string }) => thread.id !== "side-1"));
  const all = await (await get("/api/threads?includeArchived=true")).json();
  const archived = all.threads.find((thread: { id: string }) => thread.id === "side-1");
  assert.deepEqual([archived.name, archived.archived], ["Weekend", true]);
  assert.equal((await send("/api/threads/side-1", "PATCH", { archived: false })).status, 200);
  assert.equal((await send("/api/threads/side-1", "PATCH", {})).status, 422);
  assert.equal((await send("/api/threads/missing", "PATCH", { name: "x" })).status, 404);
});

test("pagination returns pages in recency order with a cursor", async () => {
  for (const id of ["p1", "p2", "p3"]) {
    await send(`/api/threads/${id}/messages`, "PUT", { messages: [user(`m-${id}`, id)] });
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const first = await (await get("/api/threads?limit=2")).json();
  assert.deepEqual(
    first.threads.map((thread: { id: string }) => thread.id),
    ["p3", "p2"],
  );
  assert.ok(first.nextCursor);
  const second = await (await get(`/api/threads?limit=2&cursor=${first.nextCursor}`)).json();
  assert.equal(second.threads[0].id, "p1");
  assert.equal((await get("/api/threads?limit=0")).status, 422);
  assert.equal((await get("/api/threads?cursor=abc")).status, 422);
});

test("threads are scoped to the authenticated owner and ignore a forged user id", async () => {
  await db.put("other-user", "threads", {
    id: "foreign",
    name: "Private",
    archived: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await db.put("other-user", "thread-messages", { id: "foreign", messages: [user("x", "secret")] });
  const list = await (await get("/api/threads?userId=other-user&includeArchived=true")).json();
  assert.ok(list.threads.every((thread: { id: string }) => thread.id !== "foreign"));
  assert.deepEqual(await (await get("/api/threads/foreign/messages?userId=other-user")).json(), {
    messages: [],
  });
  assert.equal((await send("/api/threads/foreign", "PATCH", { name: "Mine" })).status, 404);
});

test("the main chat shares its messages with /api/conversation and stays out of the side list", async () => {
  const main = await (await get("/api/main-thread")).json();
  assert.equal(main.existing, true);
  assert.equal(
    (await send(`/api/threads/${main.threadId}/messages`, "PUT", { messages: [user("mm", "Hi")] }))
      .status,
    200,
  );
  assert.equal((await (await get("/api/conversation")).json()).messages[0].content, "Hi");
  assert.equal(
    (await send("/api/conversation", "PUT", { messages: [user("mm", "Hi"), user("m2", "Again")] }))
      .status,
    200,
  );
  const history = await (await get(`/api/threads/${main.threadId}/messages`)).json();
  assert.equal(history.messages.length, 2);
  const list = await (await get("/api/threads?includeArchived=true")).json();
  assert.ok(list.threads.every((thread: { id: string }) => thread.id !== main.threadId));
});

test("workspace snapshot no longer reports an external thread service", async () => {
  const body = await (await get("/api/workspace")).text();
  assert.equal("richThreads" in JSON.parse(body).runtime, false);
});
