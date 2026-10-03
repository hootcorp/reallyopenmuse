import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { type TestContext, test } from "node:test";
import { EventType, type RunAgentInput } from "@ag-ui/core";
import { MODEL_MAX_RETRIES } from "../apps/server/src/config.ts";
import { convertInput, tanstackAgent } from "../apps/server/src/engine/tanstack-agent.ts";

// adapter() is private, so these tests drive TanStackAgent against a local fake provider and
// read what the real SDKs send: path, auth header and body. Keys are fake; nothing leaves 127.0.0.1.

const ENV = [
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_BASE_URL",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
] as const;

const baseInput: RunAgentInput = {
  threadId: "t",
  runId: "r",
  messages: [{ id: "m1", role: "user", content: "Hello" }],
  state: {},
  tools: [],
  context: [],
  forwardedProps: {},
};

/** Runs one agent turn; resolves with the RUN_ERROR message, or undefined when the run succeeds. */
function runError(model: string, input: RunAgentInput = baseInput) {
  const agent = tanstackAgent({ model, maxSteps: 1, tools: [], prompt: "App prompt." });
  return new Promise<string | undefined>((resolve) => {
    let error: string | undefined;
    agent.run(input).subscribe({
      next: (event) => {
        if (event.type === EventType.RUN_ERROR && "message" in event) error = String(event.message);
      },
      error: () => resolve(error),
      complete: () => resolve(error),
    });
  });
}

type Recorded = { path: string; headers: Record<string, unknown>; body: string };

/** A local provider that records requests and answers with `status` (default 400, never retried). */
async function fakeProvider(t: TestContext, status = 400) {
  const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  for (const name of ENV) delete process.env[name];
  const requests: Recorded[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url ?? "", headers: request.headers, body });
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({ error: { message: "Fixture refusal", type: "invalid_request" } }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    for (const name of ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { requests, origin: `http://127.0.0.1:${address.port}` };
}

test("anthropic/ calls the Messages API with ANTHROPIC_API_KEY and a /v1-stripped base URL", async (t) => {
  const { requests, origin } = await fakeProvider(t);
  process.env.ANTHROPIC_API_KEY = "fake-anthropic-key";
  // The AI SDK style base URL ends in /v1; the adapter strips it so the SDK does not add /v1 twice.
  for (const suffix of ["/v1", "/v1/"]) {
    requests.length = 0;
    process.env.ANTHROPIC_BASE_URL = `${origin}${suffix}`;
    const error = await runError("anthropic/claude-fixture");
    assert.match(error ?? "", /Fixture refusal/);
    assert.equal(requests.length, 1, "a 400 is not retried");
    const [request] = requests;
    assert.equal(new URL(request.path, origin).pathname, "/v1/messages");
    assert.equal(request.headers["x-api-key"], "fake-anthropic-key");
    const body = JSON.parse(request.body);
    assert.equal(body.model, "claude-fixture");
    assert.equal(body.stream, true);
    assert.deepEqual(body.messages, [{ role: "user", content: "Hello" }]);
  }
});

test("anthropic/ without ANTHROPIC_API_KEY fails the run before any request", async (t) => {
  const { requests, origin } = await fakeProvider(t);
  process.env.ANTHROPIC_BASE_URL = `${origin}/v1`;
  assert.equal(
    await runError("anthropic/claude-fixture"),
    "ANTHROPIC_API_KEY is not set. Please set the ANTHROPIC_API_KEY environment variable or pass the API key directly.",
  );
  assert.equal(requests.length, 0);
});

test("google/, gemini/ and google-gemini/ all select the Gemini adapter, in any case, with / or :", async (t) => {
  const { requests, origin } = await fakeProvider(t);
  process.env.GOOGLE_API_KEY = "fake-google-key";
  // The AI SDK style base URL ends in /v1beta; @google/genai adds the API version itself.
  process.env.GOOGLE_GENERATIVE_AI_BASE_URL = `${origin}/v1beta`;
  for (const spec of [
    "google/gemini-fixture",
    "gemini/gemini-fixture",
    "google-gemini/gemini-fixture",
    "Google:gemini-fixture",
    "  GEMINI/gemini-fixture ",
  ]) {
    requests.length = 0;
    assert.match((await runError(spec)) ?? "", /Fixture refusal/, spec);
    assert.equal(requests.length, 1, spec);
    const [request] = requests;
    assert.equal(
      request.path,
      "/v1beta/models/gemini-fixture:streamGenerateContent?alt=sse",
      `${spec} path`,
    );
    assert.equal(request.headers["x-goog-api-key"], "fake-google-key", `${spec} key`);
    const body = JSON.parse(request.body);
    assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "Hello" }] }]);
  }
});

test("google/ accepts GEMINI_API_KEY and without any key fails the run before any request", async (t) => {
  const { requests, origin } = await fakeProvider(t);
  process.env.GOOGLE_GENERATIVE_AI_BASE_URL = `${origin}/v1beta/`;
  assert.equal(
    await runError("google/gemini-fixture"),
    "GOOGLE_API_KEY or GEMINI_API_KEY is not set. Please set one of these environment variables or pass the API key directly.",
  );
  assert.equal(requests.length, 0);

  process.env.GEMINI_API_KEY = "fake-gemini-key";
  assert.match((await runError("google/gemini-fixture")) ?? "", /Fixture refusal/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers["x-goog-api-key"], "fake-gemini-key");
  assert.equal(
    new URL(requests[0].path, origin).pathname,
    "/v1beta/models/gemini-fixture:streamGenerateContent",
  );
});

test("provider SDKs retry a transient 500 MODEL_MAX_RETRIES times (Gemini counts attempts)", async (t) => {
  const { requests, origin } = await fakeProvider(t, 500);
  process.env.ANTHROPIC_API_KEY = "fake-anthropic-key";
  process.env.ANTHROPIC_BASE_URL = `${origin}/v1`;
  process.env.GOOGLE_API_KEY = "fake-google-key";
  process.env.GOOGLE_GENERATIVE_AI_BASE_URL = `${origin}/v1beta`;
  await runError("anthropic/claude-fixture");
  assert.equal(requests.length, MODEL_MAX_RETRIES + 1, "anthropic: first call plus retries");
  requests.length = 0;
  await runError("google/gemini-fixture");
  assert.equal(requests.length, MODEL_MAX_RETRIES + 1, "gemini: attempts = retries + 1");
});

test("a model string without a provider or model is rejected with the usage hint", async (t) => {
  const { requests } = await fakeProvider(t);
  for (const spec of ["claude-sonnet", "anthropic/", "anthropic/   ", "/gemini"])
    assert.equal(
      await runError(spec),
      `Invalid model string "${spec}". Use "openai/gpt-5", "anthropic/claude-sonnet-4.5", or "google/gemini-2.5-pro".`,
      spec,
    );
  assert.equal(requests.length, 0);
});

test("convertInput moves system and developer messages into the system prompts", () => {
  const converted = convertInput({
    ...baseInput,
    messages: [
      { id: "s", role: "system", content: "Be brief." },
      { id: "u", role: "user", content: "Hi" },
      { id: "d", role: "developer", content: "Use French." },
      { id: "e", role: "system", content: "" },
      { id: "a", role: "assistant", content: "Bonjour" },
    ],
  });
  assert.deepEqual(converted.systemPrompts, ["Be brief.", "Use French."]);
  assert.deepEqual(converted.messages, [
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Bonjour" },
  ]);
  assert.deepEqual(converted.tools, []);
});

test("system and developer prompts and context reach the provider after the app prompt", async (t) => {
  const { requests, origin } = await fakeProvider(t);
  process.env.ANTHROPIC_API_KEY = "fake-anthropic-key";
  process.env.ANTHROPIC_BASE_URL = `${origin}/v1`;
  await runError("anthropic/claude-fixture", {
    ...baseInput,
    messages: [
      { id: "s", role: "system", content: "Be brief." },
      { id: "u", role: "user", content: "Hi" },
      { id: "d", role: "developer", content: "Use French." },
    ],
    context: [{ description: "Screen", value: "chat" }],
  });
  const body = JSON.parse(requests[0].body);
  assert.deepEqual(body.messages, [{ role: "user", content: "Hi" }]);
  assert.deepEqual(body.system, [
    {
      type: "text",
      text: "App prompt.\nBe brief.\nUse French.\n## Context from the application\nScreen:\nchat\n",
    },
  ]);
});
