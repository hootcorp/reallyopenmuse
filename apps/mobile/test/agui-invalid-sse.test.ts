import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  Agent,
  fetchTransport,
  type Message,
  SseParser,
  type Transport,
} from "../../../packages/agui/src/index.ts";

// A frame whose data is not valid JSON is skipped, reported through onError, and never costs the
// valid events around it. Comments, [DONE] and empty data stay silent and are not counted as errors.

const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`;

test("SseParser skips a frame that is not valid JSON and reports it", () => {
  const errors: { error: unknown; data: string }[] = [];
  const parser = new SseParser((error, data) => errors.push({ error, data }));
  assert.deepEqual(parser.push("data: {not json}\n\n"), []);
  assert.deepEqual(parser.push("data: hello\n\n"), []);
  assert.deepEqual(parser.push("data: \n\ndata: {\n\n"), []);
  assert.deepEqual(
    errors.map((entry) => entry.data),
    ["{not json}", "hello", "{"],
  );
  for (const { error } of errors) assert.ok(error instanceof SyntaxError);
  assert.equal(parser.invalidFrames, 3);
});

test("SseParser without a handler still skips invalid frames and counts them", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push(`${frame({ a: 1 })}data: oops\n\n`), [{ a: 1 }]);
  assert.equal(parser.invalidFrames, 1);
});

test("[DONE], empty data and comments are neither events nor errors", () => {
  const errors: string[] = [];
  const parser = new SseParser((_error, data) => errors.push(data));
  assert.deepEqual(parser.push("data: [DONE]\n\ndata:\n\n: comment\n\n"), []);
  assert.deepEqual(errors, []);
  assert.equal(parser.invalidFrames, 0);
});

test("an invalid frame in the middle of a chunk keeps the valid events before and after it", () => {
  const errors: string[] = [];
  const parser = new SseParser((_error, data) => errors.push(data));
  const chunk = `${frame({ first: 1 })}data: oops\n\n${frame({ third: 3 })}`;
  assert.deepEqual(parser.push(chunk), [{ first: 1 }, { third: 3 }]);
  assert.deepEqual(errors, ["oops"]);
  assert.deepEqual(parser.push(""), [], "nothing is left over in the buffer");
});

test("an invalid frame at the start or at the end of a chunk loses nothing either", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push(`data: oops\n\n${frame({ a: 1 })}${frame({ b: 2 })}`), [
    { a: 1 },
    { b: 2 },
  ]);
  assert.deepEqual(parser.push(`${frame({ c: 3 })}${frame({ d: 4 })}data: oops\n\n`), [
    { c: 3 },
    { d: 4 },
  ]);
  assert.equal(parser.invalidFrames, 2);
});

test("several invalid frames in one chunk are all skipped and all reported", () => {
  const errors: string[] = [];
  const parser = new SseParser((_error, data) => errors.push(data));
  const chunk = `data: x1\n\n${frame({ a: 1 })}data: x2\n\ndata: x3\n\n${frame({ b: 2 })}data: x4\n\n`;
  assert.deepEqual(parser.push(chunk), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(errors, ["x1", "x2", "x3", "x4"]);
  assert.equal(parser.invalidFrames, 4);
});

test("a JSON split over two chunks that turns out invalid is skipped when the frame ends", () => {
  const errors: string[] = [];
  const parser = new SseParser((_error, data) => errors.push(data));
  assert.deepEqual(parser.push(`${frame({ a: 1 })}data: {not `), [{ a: 1 }]);
  assert.deepEqual(errors, [], "an unfinished frame is not parsed yet");
  assert.deepEqual(parser.push(`json}\n\n${frame({ b: 2 })}`), [{ b: 2 }]);
  assert.deepEqual(errors, ["{not json}"]);
});

test("a multi-line invalid frame is reported with its lines joined, CRLF included", () => {
  const errors: string[] = [];
  const parser = new SseParser((_error, data) => errors.push(data));
  assert.deepEqual(parser.push('data: {"a":\r\ndata: oops\r\n\r\n'), []);
  assert.deepEqual(errors, ['{"a":\noops']);
});

test("a handler that throws does not bring the loss back", () => {
  const parser = new SseParser(() => {
    throw new Error("handler failed");
  });
  assert.deepEqual(parser.push(`${frame({ a: 1 })}data: oops\n\n${frame({ b: 2 })}`), [
    { a: 1 },
    { b: 2 },
  ]);
  assert.equal(parser.invalidFrames, 1);
});

/** A transport that hands the given chunks to onText, then answers with `status`. */
const scripted =
  (chunks: string[], status = 200): Transport =>
  async (request) => {
    for (const chunk of chunks) request.onText(chunk);
    return { status, errorText: "" };
  };

const agentWith = (
  transport: Transport,
  extra: { url?: string; onInvalidEvent?: (error: unknown, data: string) => void } = {},
) =>
  new Agent({
    url: extra.url ?? "https://host.test/run",
    threadId: "t",
    headers: () => ({}),
    transport,
    onInvalidEvent: extra.onInvalidEvent,
  });

const text = (delta: string, first = false) =>
  frame({
    type: "TEXT_MESSAGE_CHUNK",
    messageId: "a",
    ...(first ? { role: "assistant" } : {}),
    delta,
  });

test("Agent.run ignores an invalid frame inside a chunk and finishes with the right messages", async () => {
  const agent = agentWith(
    scripted([
      frame({ type: "RUN_STARTED" }),
      `${text("One", true)}data: {broken\n\n${text(" Two")}`,
      frame({ type: "RUN_FINISHED" }),
    ]),
  );
  const running: boolean[] = [];
  agent.subscribe(() => running.push(agent.isRunning));
  await agent.run();
  assert.deepEqual(agent.messages as Message[], [
    { id: "a", role: "assistant", content: "One Two" },
  ]);
  assert.equal(agent.isRunning, false);
  assert.equal(running[0], true);
  assert.equal(running.at(-1), false);
  assert.equal(agent.invalidEventCount, 1);
});

test("Agent reports each invalid frame through onInvalidEvent, with the raw data", async () => {
  const seen: { error: unknown; data: string }[] = [];
  const agent = agentWith(
    scripted([
      `data: nope\n\n${text("Hi", true)}`,
      `data: {"type":\n\n${frame({ type: "RUN_FINISHED" })}`,
    ]),
    { onInvalidEvent: (error, data) => seen.push({ error, data }) },
  );
  await agent.run();
  assert.deepEqual(
    seen.map((entry) => entry.data),
    ["nope", '{"type":'],
  );
  for (const { error } of seen) assert.ok(error instanceof SyntaxError);
  assert.equal(agent.invalidEventCount, 2);
  assert.equal((agent.messages[0] as { content: string }).content, "Hi");
});

test("invalid frames do not mask the other failures: RUN_ERROR, missing RUN_FINISHED, HTTP status", async () => {
  await assert.rejects(
    agentWith(
      scripted([frame({ type: "RUN_ERROR", message: "Model failed" }), "data: oops\n\n"]),
    ).run(),
    /^Error: Model failed$/,
  );
  await assert.rejects(
    agentWith(scripted([frame({ type: "RUN_STARTED" }), "data: oops\n\n"])).run(),
    /^Error: Connection interrupted$/,
  );
  const failing: Transport = async () => ({ status: 500, errorText: "data: oops" });
  await assert.rejects(agentWith(failing).run(), /^Error: Request failed \(500\)$/);
});

test("Agent keeps counting invalid frames across runs and can run again", async () => {
  const agent = agentWith(scripted(["data: nope\n\n", frame({ type: "RUN_FINISHED" })]));
  await agent.run();
  await agent.run();
  assert.equal(agent.invalidEventCount, 2);
  assert.equal(agent.isRunning, false);
});

test("over a real HTTP stream with fetchTransport, an invalid event is ignored and the run completes", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    // One write holds a valid, an invalid and a valid frame; the invalid one also straddles writes.
    response.write(
      `${frame({ type: "RUN_STARTED" })}${text("Hel", true)}data: {broken\n\n${text("lo")}`,
    );
    setTimeout(() => {
      response.write("data: {half");
      setTimeout(() => {
        response.write(` of json\n\n${text("!")}`);
        response.end(frame({ type: "RUN_FINISHED" }));
      }, 10);
    }, 10);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const bad: string[] = [];
    const agent = agentWith(fetchTransport, {
      url: `http://127.0.0.1:${address.port}/run`,
      onInvalidEvent: (_error, data) => bad.push(data),
    });
    await agent.run();
    assert.deepEqual(agent.messages as Message[], [
      { id: "a", role: "assistant", content: "Hello!" },
    ]);
    assert.deepEqual(bad, ["{broken", "{half of json"]);
    assert.equal(agent.isRunning, false);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
