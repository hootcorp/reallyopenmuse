import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Agent,
  defaultTransport,
  fetchTransport,
  type Message,
  StreamAbortError,
  type Transport,
  xhrTransport,
} from "../../../packages/agui/src/index.ts";

/** The part of XMLHttpRequest that xhrTransport uses; tests drive it by hand. */
class FakeXhr {
  static instances: FakeXhr[] = [];
  method = "";
  url = "";
  sent: string | undefined;
  responseType = "";
  readonly headers: Record<string, string> = {};
  aborted = 0;
  status = 0;
  responseText = "";
  onprogress: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  constructor() {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: string) {
    this.sent = body;
  }
  abort() {
    this.aborted++;
  }
  /** The response head arrived: status known, body still streaming. */
  head(status: number) {
    this.status = status;
  }
  /** `responseText` grows by `text` and onprogress fires, as in a browser or React Native. */
  progress(text: string) {
    this.responseText += text;
    this.onprogress?.();
  }
  finish(text = "") {
    this.responseText += text;
    this.onload?.();
  }
}

/** Installs FakeXhr as the global XMLHttpRequest for one test. */
function installXhr(t: { after: (fn: () => void) => void }) {
  const global = globalThis as { XMLHttpRequest?: unknown };
  const previous = global.XMLHttpRequest;
  FakeXhr.instances = [];
  global.XMLHttpRequest = FakeXhr;
  t.after(() => {
    if (previous === undefined) delete global.XMLHttpRequest;
    else global.XMLHttpRequest = previous;
  });
  return () => {
    assert.equal(FakeXhr.instances.length, 1, "exactly one XMLHttpRequest was created");
    return FakeXhr.instances[0];
  };
}

function requestFor(overrides: Partial<Parameters<Transport>[0]> = {}) {
  const controller = new AbortController();
  const chunks: string[] = [];
  const request: Parameters<Transport>[0] = {
    url: "https://host.test/api/agui/run",
    headers: { "Content-Type": "application/json", Authorization: "Bearer token" },
    body: '{"hello":"world"}',
    signal: controller.signal,
    onText: (chunk) => chunks.push(chunk),
    ...overrides,
  };
  return { request, controller, chunks };
}

const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`;

test("xhrTransport posts the body with the headers and reports text incrementally", async (t) => {
  const xhr = installXhr(t);
  const { request, chunks } = requestFor();
  const result = xhrTransport(request);
  const fake = xhr();
  assert.equal(fake.method, "POST");
  assert.equal(fake.url, "https://host.test/api/agui/run");
  assert.deepEqual(fake.headers, {
    "Content-Type": "application/json",
    Authorization: "Bearer token",
  });
  assert.equal(fake.responseType, "text");
  assert.equal(fake.sent, '{"hello":"world"}');

  fake.head(200);
  fake.progress("data: {");
  fake.progress("");
  assert.deepEqual(chunks, ["data: {"], "an unchanged responseText delivers nothing");
  fake.progress('"a":1}\n\ndata: ');
  // responseText is cumulative; only the new tail is passed on each time.
  assert.deepEqual(chunks, ["data: {", '"a":1}\n\ndata: ']);
  fake.finish('{"b":2}\n\n');
  assert.deepEqual(
    chunks,
    ["data: {", '"a":1}\n\ndata: ', '{"b":2}\n\n'],
    "onload flushes the rest",
  );
  assert.deepEqual(await result, { status: 200, errorText: "" });
});

test("xhrTransport ignores progress until the status is 2xx and returns an error body as text", async (t) => {
  const xhr = installXhr(t);
  const { request, chunks } = requestFor();
  const result = xhrTransport(request);
  const fake = xhr();
  // Before the response head arrives, status is 0: nothing is delivered.
  fake.onprogress?.();
  assert.deepEqual(chunks, []);
  fake.head(503);
  fake.progress('{"error":"Configure a model"}');
  fake.finish();
  assert.deepEqual(chunks, [], "an error body is never passed to onText");
  assert.deepEqual(await result, { status: 503, errorText: '{"error":"Configure a model"}' });
});

test("xhrTransport status edges: 204 has no error text, redirects (3xx) are reported as errors", async (t) => {
  const xhr = installXhr(t);
  for (const [status, errorText] of [
    [204, ""],
    [299, ""],
    [300, "moved"],
    [404, "gone"],
  ] as const) {
    FakeXhr.instances = [];
    const { request, chunks } = requestFor();
    const result = xhrTransport(request);
    const fake = xhr();
    fake.head(status);
    fake.finish(status >= 300 ? errorText : "");
    assert.deepEqual(await result, { status, errorText }, `status ${status}`);
    // 204 and 299 are 2xx, so an (empty) body goes through pump; nothing to deliver.
    assert.deepEqual(chunks, []);
  }
});

test("xhrTransport: a 3xx body is returned as errorText, not streamed", async (t) => {
  const xhr = installXhr(t);
  const { request, chunks } = requestFor();
  const result = xhrTransport(request);
  const fake = xhr();
  fake.head(302);
  fake.progress("redirect body");
  fake.finish();
  assert.deepEqual(chunks, []);
  assert.deepEqual(await result, { status: 302, errorText: "redirect body" });
});

test("xhrTransport rejects with an AbortError before opening a request when already aborted", async (t) => {
  installXhr(t);
  const { request, controller } = requestFor();
  controller.abort();
  await assert.rejects(xhrTransport(request), (error: unknown) => {
    assert.ok(error instanceof StreamAbortError);
    assert.equal(error.name, "AbortError");
    assert.equal(error.message, "The request was cancelled");
    return true;
  });
  assert.equal(FakeXhr.instances.length, 0, "no XMLHttpRequest was created");
});

test("xhrTransport aborts the XMLHttpRequest and rejects when the signal fires mid-stream", async (t) => {
  const xhr = installXhr(t);
  const { request, controller, chunks } = requestFor();
  const result = xhrTransport(request);
  const fake = xhr();
  fake.head(200);
  fake.progress("data: one\n\n");
  controller.abort();
  await assert.rejects(result, (error: unknown) => error instanceof StreamAbortError);
  assert.equal(fake.aborted, 1);
  assert.deepEqual(chunks, ["data: one\n\n"], "what arrived before the abort was delivered");
});

test("xhrTransport stops listening to the signal once the request has finished", async (t) => {
  const xhr = installXhr(t);
  const { request, controller } = requestFor();
  const result = xhrTransport(request);
  const fake = xhr();
  fake.head(200);
  fake.finish("");
  await result;
  controller.abort();
  assert.equal(fake.aborted, 0, "a finished request is not aborted afterwards");
});

test("xhrTransport maps a network error and a timeout to TypeErrors", async (t) => {
  const xhr = installXhr(t);
  const first = xhrTransport(requestFor().request);
  xhr().onerror?.();
  await assert.rejects(first, (error: unknown) => {
    assert.ok(error instanceof TypeError);
    assert.equal(error.message, "Network request failed");
    return true;
  });

  FakeXhr.instances = [];
  const second = xhrTransport(requestFor().request);
  xhr().ontimeout?.();
  await assert.rejects(second, (error: unknown) => {
    assert.ok(error instanceof TypeError);
    assert.equal(error.message, "Network request timed out");
    return true;
  });
});

test("xhrTransport settles once: an error after load or a second error is ignored", async (t) => {
  const xhr = installXhr(t);
  const result = xhrTransport(requestFor().request);
  const fake = xhr();
  fake.head(200);
  fake.finish();
  fake.onerror?.();
  fake.ontimeout?.();
  assert.deepEqual(await result, { status: 200, errorText: "" });
});

test("xhrTransport: a throwing onText rejects with that error and aborts the request", async (t) => {
  const xhr = installXhr(t);
  const boom = new Error("consumer failed");
  const result = xhrTransport(
    requestFor({
      onText: () => {
        throw boom;
      },
    }).request,
  );
  const fake = xhr();
  fake.head(200);
  fake.progress("data: x\n\n");
  await assert.rejects(result, (error: unknown) => error === boom);
  assert.equal(fake.aborted, 1);
});

test("xhrTransport: a throwing onText during onload rejects without aborting", async (t) => {
  const xhr = installXhr(t);
  const boom = new Error("consumer failed late");
  const result = xhrTransport(
    requestFor({
      onText: () => {
        throw boom;
      },
    }).request,
  );
  const fake = xhr();
  fake.head(200);
  fake.finish("data: x\n\n");
  await assert.rejects(result, (error: unknown) => error === boom);
  assert.equal(fake.aborted, 0);
});

test("defaultTransport picks xhrTransport when XMLHttpRequest exists, fetchTransport otherwise", (t) => {
  assert.equal(typeof XMLHttpRequest, "undefined", "Node has no XMLHttpRequest");
  assert.equal(defaultTransport(), fetchTransport);
  installXhr(t);
  assert.equal(defaultTransport(), xhrTransport);
});

const agentWith = (transport = xhrTransport) =>
  new Agent({
    url: "https://host.test/api/agui/run",
    threadId: "thread-1",
    headers: () => ({ Authorization: "Bearer token" }),
    context: () => [{ description: "Screen", value: "chat" }],
    transport,
  });

test("Agent.run over xhrTransport folds chunked events from a streamed response", async (t) => {
  const xhr = installXhr(t);
  const agent = agentWith();
  agent.addMessage({ id: "u1", role: "user", content: "Hello" });
  const seen: boolean[] = [];
  agent.subscribe(() => seen.push(agent.isRunning));
  const running = agent.run();
  const fake = xhr();
  const body = JSON.parse(fake.sent ?? "");
  assert.equal(body.threadId, "thread-1");
  assert.deepEqual(body.messages, [{ id: "u1", role: "user", content: "Hello" }]);
  assert.deepEqual(body.context, [{ description: "Screen", value: "chat" }]);
  assert.equal(fake.headers.Authorization, "Bearer token");
  assert.equal(fake.headers.Accept, "text/event-stream");
  assert.equal(agent.isRunning, true);

  const first = frame({ type: "RUN_STARTED", threadId: "thread-1", runId: "r" });
  const second = frame({
    type: "TEXT_MESSAGE_CHUNK",
    messageId: "a",
    role: "assistant",
    delta: "Hi ",
  });
  fake.head(200);
  fake.progress(first + second.slice(0, 25));
  assert.deepEqual(agent.messages.length, 1, "only the user message until a frame completes");
  fake.progress(second.slice(25));
  assert.deepEqual(agent.messages[1], { id: "a", role: "assistant", content: "Hi " });
  fake.progress(frame({ type: "TEXT_MESSAGE_CHUNK", messageId: "a", delta: "there" }));
  fake.finish(frame({ type: "RUN_FINISHED", threadId: "thread-1", runId: "r" }));
  await running;
  assert.deepEqual(agent.messages as Message[], [
    { id: "u1", role: "user", content: "Hello" },
    { id: "a", role: "assistant", content: "Hi there" },
  ]);
  assert.equal(agent.isRunning, false);
  assert.ok(seen.includes(true));
  assert.equal(seen.at(-1), false);
});

test("Agent.run over xhrTransport surfaces a non-2xx JSON error, a network error and a stop", async (t) => {
  const xhr = installXhr(t);
  const failing = agentWith();
  const run = failing.run();
  xhr().head(503);
  xhr().finish('{"error":"Configure a model"}');
  await assert.rejects(run, /^Error: Configure a model$/);
  assert.equal(failing.isRunning, false);

  FakeXhr.instances = [];
  const plain = agentWith();
  const plainRun = plain.run();
  xhr().head(502);
  xhr().finish("<html>Bad gateway</html>");
  await assert.rejects(plainRun, /^Error: Request failed \(502\)$/);

  FakeXhr.instances = [];
  const offline = agentWith();
  const offlineRun = offline.run();
  xhr().onerror?.();
  await assert.rejects(offlineRun, /^TypeError: Network request failed$/);
  assert.equal(offline.isRunning, false);

  FakeXhr.instances = [];
  const stopped = agentWith();
  const stoppedRun = stopped.run();
  const fake = xhr();
  fake.head(200);
  fake.progress(frame({ type: "TEXT_MESSAGE_CHUNK", messageId: "a", delta: "One" }));
  stopped.stop();
  await stoppedRun; // a stop resolves quietly
  assert.equal(fake.aborted, 1);
  assert.equal(stopped.isRunning, false);
  assert.equal((stopped.messages[0] as { content: string }).content, "One");
});

test("Agent.run over xhrTransport: a stream that ends without RUN_FINISHED is interrupted", async (t) => {
  const xhr = installXhr(t);
  const agent = agentWith();
  const run = agent.run();
  const fake = xhr();
  fake.head(200);
  fake.finish(frame({ type: "RUN_STARTED" }));
  await assert.rejects(run, /^Error: Connection interrupted$/);
});

test("Agent.run over xhrTransport ignores an invalid event and finishes with the right messages", async (t) => {
  const xhr = installXhr(t);
  const bad: string[] = [];
  const agent = new Agent({
    url: "https://host.test/api/agui/run",
    threadId: "thread-1",
    headers: () => ({}),
    transport: xhrTransport,
    onInvalidEvent: (_error, data) => bad.push(data),
  });
  const running = agent.run();
  const fake = xhr();
  const chunk = (delta: string, role?: string) =>
    frame({ type: "TEXT_MESSAGE_CHUNK", messageId: "a", delta, ...(role ? { role } : {}) });
  fake.head(200);
  // Valid, invalid and valid frames in one progress event; a second invalid one split across two.
  fake.progress(`${chunk("Hel", "assistant")}data: {broken\n\n${chunk("lo")}data: {half`);
  assert.equal((agent.messages[0] as { content: string }).content, "Hello");
  fake.progress(` of json\n\n${chunk("!")}`);
  fake.finish(frame({ type: "RUN_FINISHED" }));
  await running; // resolves: the xhr was not aborted by the bad frames
  assert.equal(fake.aborted, 0);
  assert.deepEqual(agent.messages as Message[], [
    { id: "a", role: "assistant", content: "Hello!" },
  ]);
  assert.deepEqual(bad, ["{broken", "{half of json"]);
  assert.equal(agent.isRunning, false);
});
