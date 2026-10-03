import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  Agent,
  type AguiEvent,
  applyEvent,
  fetchTransport,
  type Message,
  parseToolArguments,
  SseParser,
} from "../../../packages/agui/src/index.ts";

const fold = (events: AguiEvent[], start: Message[] = []) => events.reduce(applyEvent, start);

test("text events build one assistant message, chunks create it on demand", () => {
  const messages = fold([
    { type: "TEXT_MESSAGE_START", messageId: "a", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "Hel" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "lo" },
    { type: "TEXT_MESSAGE_END", messageId: "a" },
    { type: "TEXT_MESSAGE_CHUNK", messageId: "b", role: "assistant", delta: "Second" },
  ]);
  assert.deepEqual(messages, [
    { id: "a", role: "assistant", content: "Hello" },
    { id: "b", role: "assistant", content: "Second" },
  ]);
});

test("a tool call attaches to its parent message, streams arguments and gets a result", () => {
  const messages = fold(
    [
      { type: "TEXT_MESSAGE_CHUNK", messageId: "m1", delta: "Reading." },
      {
        type: "TOOL_CALL_START",
        toolCallId: "t1",
        toolCallName: "browse_web",
        parentMessageId: "m1",
      },
      { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: '{"url":"https:' },
      { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: '//example.com"}' },
      { type: "TOOL_CALL_END", toolCallId: "t1" },
      { type: "TOOL_CALL_RESULT", toolCallId: "t1", messageId: "r1", role: "tool", content: "{}" },
      { type: "TEXT_MESSAGE_CHUNK", messageId: "m2", delta: "Done." },
    ],
    [{ id: "u", role: "user", content: "Read it" }],
  );
  assert.equal(messages.length, 4);
  const first = messages[1];
  assert.ok(first.role === "assistant");
  assert.equal(first.content, "Reading.");
  assert.deepEqual(first.toolCalls, [
    {
      id: "t1",
      type: "function",
      function: { name: "browse_web", arguments: '{"url":"https://example.com"}' },
    },
  ]);
  assert.deepEqual(messages[2], { id: "r1", role: "tool", toolCallId: "t1", content: "{}" });
  assert.equal(messages[3].id, "m2");
});

test("a tool call without a parent starts its own assistant message; replays change nothing", () => {
  const events: AguiEvent[] = [
    { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "x", parentMessageId: "p" },
    { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "x", parentMessageId: "p" },
  ];
  const messages = fold(events);
  assert.equal(messages.length, 1);
  assert.equal((messages[0] as { toolCalls: unknown[] }).toolCalls.length, 1);
  const result = { type: "TOOL_CALL_RESULT", toolCallId: "t1", messageId: "r", content: "1" };
  const once = fold([result], messages);
  assert.equal(fold([result], once), once);
});

test("tool call chunks start a call by name and append arguments", () => {
  const messages = fold([
    {
      type: "TOOL_CALL_CHUNK",
      toolCallId: "t",
      toolCallName: "n",
      parentMessageId: "p",
      delta: "{",
    },
    { type: "TOOL_CALL_CHUNK", toolCallId: "t", delta: "}" },
  ]);
  const call = (messages[0] as { toolCalls: { function: { arguments: string } }[] }).toolCalls[0];
  assert.equal(call.function.arguments, "{}");
});

test("unrelated events leave the transcript untouched and snapshots replace it", () => {
  const start: Message[] = [{ id: "u", role: "user", content: "Hi" }];
  assert.equal(applyEvent(start, { type: "RUN_STARTED" }), start);
  assert.equal(applyEvent(start, { type: "STATE_DELTA", delta: [] }), start);
  const snapshot: Message[] = [{ id: "z", role: "user", content: "Other" }];
  assert.equal(applyEvent(start, { type: "MESSAGES_SNAPSHOT", messages: snapshot }), snapshot);
});

test("partial tool arguments parse to an empty object until they are complete JSON", () => {
  assert.deepEqual(parseToolArguments('{"url":"https://exa'), {});
  assert.deepEqual(parseToolArguments(""), {});
  assert.deepEqual(parseToolArguments("[1]"), {});
  assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
});

test("SSE parser handles split chunks, CRLF, comments and multi-line data", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push('data: {"a":1}\n\n: ping\n\ndata: {"b"'), [{ a: 1 }]);
  assert.deepEqual(parser.push(":2}\r\n\r\ndata: [DONE]\n\n"), [{ b: 2 }]);
  assert.deepEqual(parser.push('event: x\ndata: {"c":\ndata: 3}\n\n'), [{ c: 3 }]);
});

async function sseServer(
  handler: (body: {
    messages: Message[];
    context: unknown[];
    threadId: string;
  }) => string[] | number,
) {
  const requests: { headers: Record<string, unknown>; body: any }[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ headers: request.headers, body });
    const result = handler(body);
    if (typeof result === "number") {
      response.writeHead(result, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Configure a model" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const part of result) {
      response.write(part);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/api/agui/run`,
    requests,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`;
const agentFor = (url: string) =>
  new Agent({
    url,
    threadId: "thread-1",
    headers: () => ({ Authorization: "Bearer token" }),
    context: () => [{ description: "Screen", value: "chat" }],
    transport: fetchTransport,
  });

test("a run posts the transcript, folds streamed events and notifies subscribers", async () => {
  const server = await sseServer(() => [
    frame({ type: "RUN_STARTED", threadId: "thread-1", runId: "r" }),
    frame({ type: "TEXT_MESSAGE_CHUNK", messageId: "a", role: "assistant", delta: "Hi " }).slice(
      0,
      20,
    ),
    `${frame({ type: "TEXT_MESSAGE_CHUNK", messageId: "a", role: "assistant", delta: "Hi " }).slice(20)}`,
    frame({ type: "TEXT_MESSAGE_CHUNK", messageId: "a", delta: "there" }),
    frame({ type: "RUN_FINISHED", threadId: "thread-1", runId: "r" }),
  ]);
  try {
    const agent = agentFor(server.url);
    let notifications = 0;
    agent.subscribe(() => notifications++);
    agent.addMessage({ id: "u1", role: "user", content: "Hello" });
    const running: boolean[] = [];
    agent.subscribe(() => running.push(agent.isRunning));
    await agent.run();
    assert.deepEqual(agent.messages, [
      { id: "u1", role: "user", content: "Hello" },
      { id: "a", role: "assistant", content: "Hi there" },
    ]);
    assert.equal(agent.isRunning, false);
    assert.ok(running.includes(true));
    assert.ok(notifications >= 4);
    const [request] = server.requests;
    assert.equal(request.headers.authorization, "Bearer token");
    assert.equal(request.body.threadId, "thread-1");
    assert.deepEqual(request.body.messages, [{ id: "u1", role: "user", content: "Hello" }]);
    assert.deepEqual(request.body.context, [{ description: "Screen", value: "chat" }]);
  } finally {
    server.close();
  }
});

test("a RUN_ERROR rejects with the server's message and keeps the partial reply", async () => {
  const server = await sseServer(() => [
    frame({ type: "TEXT_MESSAGE_CHUNK", messageId: "a", delta: "Partial" }),
    frame({ type: "RUN_ERROR", message: "Model failed" }),
  ]);
  try {
    const agent = agentFor(server.url);
    await assert.rejects(agent.run(), /Model failed/);
    assert.equal(agent.isRunning, false);
    assert.equal((agent.messages[0] as { content: string }).content, "Partial");
  } finally {
    server.close();
  }
});

test("a stream that ends without RUN_FINISHED is reported as interrupted", async () => {
  const server = await sseServer(() => [frame({ type: "RUN_STARTED" })]);
  try {
    await assert.rejects(agentFor(server.url).run(), /Connection interrupted/);
  } finally {
    server.close();
  }
});

test("an HTTP error surfaces the server's error message", async () => {
  const server = await sseServer(() => 503);
  try {
    await assert.rejects(agentFor(server.url).run(), /Configure a model/);
  } finally {
    server.close();
  }
});

test("stop ends the run quietly and a second run is refused while one is active", async () => {
  const server = await sseServer(() => [
    frame({ type: "RUN_STARTED" }),
    frame({ type: "TEXT_MESSAGE_CHUNK", messageId: "a", delta: "One" }),
    ...Array.from({ length: 200 }, () => frame({ type: "CUSTOM", name: "wait" })),
  ]);
  try {
    const agent = agentFor(server.url);
    const running = agent.run();
    await assert.rejects(agent.run(), /already running/);
    while (!agent.messages.length) await new Promise((resolve) => setTimeout(resolve, 5));
    agent.stop();
    await running;
    assert.equal(agent.isRunning, false);
    assert.equal((agent.messages[0] as { content: string }).content, "One");
  } finally {
    server.close();
  }
});
