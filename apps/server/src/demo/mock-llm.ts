import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";

/**
 * A small scripted LLM server for the recorded demo and for tests. It speaks the OpenAI
 * Responses API (`POST /v1/responses`, streamed), which is what the built-in agent calls, and
 * hands each request to a handler in the familiar chat-completions message shape.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: {
    type: "function";
    function: { name: string; description?: string; parameters?: unknown };
  }[];
}

export interface FixtureResponse {
  content?: string;
  toolCalls?: { id?: string; name: string; arguments: string }[];
}

export function getTextContent(content: ChatMessage["content"] | undefined): string | undefined {
  return typeof content === "string" ? content : undefined;
}

type ResponsesPart = { type?: string; text?: string };
type ResponsesItem = {
  type?: string;
  role?: string;
  content?: string | ResponsesPart[];
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
};
type ResponsesRequest = {
  model: string;
  instructions?: string;
  input: string | ResponsesItem[];
  stream?: boolean;
  tools?: { type?: string; name?: string; description?: string; parameters?: unknown }[];
};

function text(content: string | ResponsesPart[] | undefined) {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "input_text" || part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");
}

/** Responses input items as chat messages; a function call and its output become a tool turn. */
export function responsesToChatRequest(request: ResponsesRequest): ChatCompletionRequest {
  const messages: ChatMessage[] = [];
  if (request.instructions) messages.push({ role: "system", content: request.instructions });
  if (typeof request.input === "string") messages.push({ role: "user", content: request.input });
  else
    for (const item of request.input) {
      if (item.role === "system" || item.role === "developer")
        messages.push({ role: "system", content: text(item.content) });
      else if (item.role === "user") messages.push({ role: "user", content: text(item.content) });
      else if (item.role === "assistant")
        messages.push({ role: "assistant", content: text(item.content) });
      else if (item.type === "function_call")
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: item.call_id ?? `call_${randomUUID()}`,
              type: "function",
              function: { name: item.name ?? "", arguments: item.arguments ?? "" },
            },
          ],
        });
      else if (item.type === "function_call_output")
        messages.push({ role: "tool", content: item.output ?? "", tool_call_id: item.call_id });
    }
  return {
    model: request.model,
    messages,
    stream: request.stream,
    tools: request.tools
      ?.filter((tool) => tool.type === "function")
      .map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name ?? "",
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
  };
}

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

/** The Responses stream events for one scripted reply: text first, then each tool call. */
export function responsesEvents(reply: FixtureResponse, model: string, chunkSize: number) {
  const respId = id("resp");
  const created = Math.floor(Date.now() / 1000);
  const envelope = { id: respId, object: "response", created_at: created, model };
  const events: object[] = [
    { type: "response.created", response: { ...envelope, status: "in_progress", output: [] } },
    { type: "response.in_progress", response: { ...envelope, status: "in_progress", output: [] } },
  ];
  const output: object[] = [];
  let index = 0;
  const content = reply.content ?? "";
  if (content || !reply.toolCalls?.length) {
    const itemId = id("msg");
    events.push({
      type: "response.output_item.added",
      output_index: index,
      item: { type: "message", id: itemId, status: "in_progress", role: "assistant", content: [] },
    });
    events.push({
      type: "response.content_part.added",
      item_id: itemId,
      output_index: index,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    for (let i = 0; i < content.length; i += chunkSize)
      events.push({
        type: "response.output_text.delta",
        item_id: itemId,
        output_index: index,
        content_index: 0,
        delta: content.slice(i, i + chunkSize),
      });
    events.push({
      type: "response.output_text.done",
      item_id: itemId,
      output_index: index,
      content_index: 0,
      text: content,
    });
    events.push({
      type: "response.content_part.done",
      item_id: itemId,
      output_index: index,
      content_index: 0,
      part: { type: "output_text", text: content, annotations: [] },
    });
    const item = {
      type: "message",
      id: itemId,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: content, annotations: [] }],
    };
    events.push({ type: "response.output_item.done", output_index: index, item });
    output.push(item);
    index++;
  }
  for (const call of reply.toolCalls ?? []) {
    const itemId = id("fc");
    const callId = call.id || id("call");
    events.push({
      type: "response.output_item.added",
      output_index: index,
      item: {
        type: "function_call",
        id: itemId,
        call_id: callId,
        name: call.name,
        arguments: "",
        status: "in_progress",
      },
    });
    for (let i = 0; i < call.arguments.length; i += chunkSize)
      events.push({
        type: "response.function_call_arguments.delta",
        item_id: itemId,
        output_index: index,
        delta: call.arguments.slice(i, i + chunkSize),
      });
    events.push({
      type: "response.function_call_arguments.done",
      item_id: itemId,
      output_index: index,
      arguments: call.arguments,
    });
    const item = {
      type: "function_call",
      id: itemId,
      call_id: callId,
      name: call.name,
      arguments: call.arguments,
      status: "completed",
    };
    events.push({ type: "response.output_item.done", output_index: index, item });
    output.push(item);
    index++;
  }
  events.push({
    type: "response.completed",
    response: { ...envelope, status: "completed", output, usage },
  });
  return events;
}

type Handler = (request: ChatCompletionRequest) => FixtureResponse | Promise<FixtureResponse>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class MockLLM {
  private server?: Server;
  private readonly handlers: { model: string; handler: Handler; firstByteDelay?: number }[] = [];
  private readonly requests: ChatCompletionRequest[] = [];
  private port = 0;
  constructor(
    private readonly options: {
      host?: string;
      port?: number;
      /** Delay between streamed events, in milliseconds. */
      latency?: number;
      /** Characters per streamed text or argument delta. */
      chunkSize?: number;
    } = {},
  ) {}
  /** Answer requests for `model` with `handler`; the first event waits `firstByteDelay` ms. */
  on(match: { model: string }, handler: Handler, options: { firstByteDelay?: number } = {}) {
    this.handlers.push({ model: match.model, handler, firstByteDelay: options.firstByteDelay });
    return this;
  }
  get url() {
    return `http://${this.options.host ?? "127.0.0.1"}:${this.port}`;
  }
  getRequests() {
    return [...this.requests];
  }
  async start() {
    const latency = this.options.latency ?? 0;
    const chunkSize = Math.max(1, this.options.chunkSize ?? 14);
    this.server = createServer(async (request, response) => {
      const fail = (status: number, message: string) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message, type: "invalid_request_error" } }));
      };
      if (request.method !== "POST" || !request.url?.split("?")[0].endsWith("/responses"))
        return fail(404, "This mock model only serves POST /v1/responses");
      let raw = "";
      for await (const chunk of request) raw += chunk;
      let body: ResponsesRequest;
      try {
        body = JSON.parse(raw);
      } catch {
        return fail(400, "Request body is not valid JSON");
      }
      const chat = responsesToChatRequest(body);
      this.requests.push(chat);
      const match = this.handlers.find((candidate) => candidate.model === body.model);
      if (!match) return fail(404, `No mock model is scripted for "${body.model}"`);
      let reply: FixtureResponse;
      try {
        reply = await match.handler(chat);
      } catch (error) {
        return fail(500, error instanceof Error ? error.message : "The mock handler failed");
      }
      let closed = false;
      response.on("close", () => {
        closed = true;
      });
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const events = responsesEvents(reply, body.model, chunkSize);
      for (const [position, event] of events.entries()) {
        const wait = position === 0 ? (match.firstByteDelay ?? latency) : latency;
        if (wait > 0) await sleep(wait);
        if (closed) return;
        response.write(
          `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      }
      response.end("data: [DONE]\n\n");
    });
    this.server.listen(this.options.port ?? 0, this.options.host ?? "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Mock model did not start");
    this.port = address.port;
    return this.url;
  }
  async stop() {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
