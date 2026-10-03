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

// SseParser does an unguarded JSON.parse on each frame's data. These tests document what that
// means today, for the parser and for Agent.run; they are not a promise that it is the best design.

const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`;

test("SseParser throws a SyntaxError from push() when a frame's data is not valid JSON", () => {
  const parser = new SseParser();
  assert.throws(() => parser.push("data: {not json}\n\n"), SyntaxError);
  assert.throws(() => new SseParser().push("data: \n\ndata: {\n\n"), SyntaxError);
  // A non-JSON word is invalid too; only the literal [DONE] and empty data are skipped.
  assert.throws(() => new SseParser().push("data: hello\n\n"), SyntaxError);
  assert.deepEqual(new SseParser().push("data: [DONE]\n\ndata:\n\n: comment\n\n"), []);
});

test("SseParser does not parse an incomplete frame, so a split JSON only fails once the frame ends", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("data: {not "), []);
  assert.throws(() => parser.push("json}\n\n"), SyntaxError);
});

test("after a throw, SseParser has consumed the bad frame and carries on with the next ones", () => {
  const parser = new SseParser();
  assert.throws(() => parser.push("data: oops\n\n"), SyntaxError);
  assert.deepEqual(parser.push(frame({ ok: 1 })), [{ ok: 1 }], "the parser is not poisoned");
});

test("oddity: a throwing push() drops the valid events parsed earlier in the same chunk", () => {
  const parser = new SseParser();
  const chunk = `${frame({ first: 1 })}data: oops\n\n${frame({ third: 3 })}`;
  // The first event was already parsed, but push() throws instead of returning it: it is lost.
  assert.throws(() => parser.push(chunk), SyntaxError);
  // The frame after the bad one is still in the buffer and is returned by the next push().
  assert.deepEqual(parser.push(""), [{ third: 3 }]);
});

/** A transport that hands the given chunks to onText, then answers with `status`. */
const scripted =
  (chunks: string[], status = 200): Transport =>
  async (request) => {
    for (const chunk of chunks) request.onText(chunk);
    return { status, errorText: "" };
  };

const agentWith = (transport: Transport, url = "https://host.test/run") =>
  new Agent({ url, threadId: "t", headers: () => ({}), transport });

test("Agent.run rejects with the SyntaxError on an invalid frame and resets isRunning", async () => {
  const agent = agentWith(
    scripted([
      frame({ type: "TEXT_MESSAGE_CHUNK", messageId: "a", role: "assistant", delta: "Partial" }),
      "data: {broken\n\n",
      frame({ type: "RUN_FINISHED" }),
    ]),
  );
  const running: boolean[] = [];
  agent.subscribe(() => running.push(agent.isRunning));
  await assert.rejects(agent.run(), (error: unknown) => {
    assert.ok(error instanceof SyntaxError, "the raw JSON.parse error, not wrapped");
    assert.notEqual(error.message, "Connection interrupted");
    return true;
  });
  assert.equal(agent.isRunning, false);
  // Subscribers saw the run start, the partial reply, and a final notification with isRunning false.
  assert.equal(running[0], true);
  assert.equal(running.at(-1), false);
  assert.deepEqual(agent.messages as Message[], [
    { id: "a", role: "assistant", content: "Partial" },
  ]);
});

test("Agent.run: events in the chunk before the bad frame are lost, earlier chunks are kept", async () => {
  const chunkOne = frame({
    type: "TEXT_MESSAGE_CHUNK",
    messageId: "a",
    role: "assistant",
    delta: "One",
  });
  const chunkTwo = `${frame({ type: "TEXT_MESSAGE_CHUNK", messageId: "a", delta: " Two" })}data: oops\n\n`;
  const agent = agentWith(scripted([chunkOne, chunkTwo]));
  await assert.rejects(agent.run(), SyntaxError);
  // " Two" arrived in the same chunk as the bad frame, so it never reaches the transcript.
  assert.deepEqual(agent.messages as Message[], [{ id: "a", role: "assistant", content: "One" }]);
});

test("Agent.run: a RUN_ERROR seen before the bad frame wins over the SyntaxError", async () => {
  const agent = agentWith(
    scripted([frame({ type: "RUN_ERROR", message: "Model failed" }), "data: oops\n\n"]),
  );
  await assert.rejects(agent.run(), /^Error: Model failed$/);
  assert.equal(agent.isRunning, false);
});

test("Agent.run can run again after an invalid frame", async () => {
  let call = 0;
  const transport: Transport = async (request) => {
    call++;
    if (call === 1) request.onText("data: nope\n\n");
    else request.onText(frame({ type: "RUN_FINISHED" }));
    return { status: 200, errorText: "" };
  };
  const agent = agentWith(transport);
  await assert.rejects(agent.run(), SyntaxError);
  await agent.run();
  assert.equal(call, 2);
  assert.equal(agent.isRunning, false);
});

test("over a real HTTP stream, an invalid frame makes fetchTransport and Agent.run reject", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(frame({ type: "RUN_STARTED", threadId: "t", runId: "r" }));
    setTimeout(() => response.end("data: {broken\n\n"), 10);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const agent = agentWith(fetchTransport, `http://127.0.0.1:${address.port}/run`);
    await assert.rejects(agent.run(), SyntaxError);
    assert.equal(agent.isRunning, false);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
