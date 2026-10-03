import { randomUUID } from "node:crypto";
import { AbstractAgent } from "@ag-ui/client";
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/core";
import { chat, maxIterations, type SchemaInput, toolDefinition } from "@tanstack/ai";
import { type AnthropicChatModel, anthropicText } from "@tanstack/ai-anthropic";
import { type GeminiTextModel, geminiText } from "@tanstack/ai-gemini";
import { type OpenAIChatModel, openaiText } from "@tanstack/ai-openai";
import { map, mergeMap, Observable } from "rxjs";
import { MODEL_MAX_RETRIES } from "../config.ts";
import type { ToolDefinition } from "./tool.ts";

// "provider/model" strings, env vars and base URL formats follow the usual AI SDK conventions.
// Each provider SDK retries transient failures up to MODEL_MAX_RETRIES times.
function adapter(spec: string) {
  const [, provider = "", model = ""] = spec.trim().match(/^([^/:]*)[/:](.*)$/) ?? [];
  if (!provider || !model.trim())
    throw new Error(
      `Invalid model string "${spec}". Use "openai/gpt-5", "anthropic/claude-sonnet-4.5", or "google/gemini-2.5-pro".`,
    );
  const id = model.trim();
  switch (provider.toLowerCase()) {
    case "openai":
      return openaiText(id as OpenAIChatModel, {
        baseURL: process.env.OPENAI_BASE_URL,
        maxRetries: MODEL_MAX_RETRIES,
      });
    case "anthropic":
      // The AI SDK base URL ends in /v1; the Anthropic SDK adds /v1 itself.
      return anthropicText(id as AnthropicChatModel, {
        baseURL: process.env.ANTHROPIC_BASE_URL?.replace(/\/v1\/?$/, ""),
        maxRetries: MODEL_MAX_RETRIES,
      });
    case "google":
    case "gemini":
    case "google-gemini":
      // The AI SDK base URL ends in /v1beta; @google/genai adds the API version itself.
      return geminiText(id as GeminiTextModel, {
        httpOptions: {
          baseUrl: process.env.GOOGLE_GENERATIVE_AI_BASE_URL?.replace(/\/v1beta\/?$/, ""),
          // @google/genai counts the first call in `attempts`.
          retryOptions: { attempts: MODEL_MAX_RETRIES + 1 },
        },
      });
    default:
      throw unknownProvider(provider, spec);
  }
}

/** With OPENAI_BASE_URL set, a gateway model ID most likely needs the openai/ prefix. */
export function unknownProvider(
  provider: string,
  spec: string,
  baseUrl = process.env.OPENAI_BASE_URL,
) {
  const hint = baseUrl?.trim()
    ? ` For a model on your OPENAI_BASE_URL gateway, use "openai/${spec.trim()}".`
    : "";
  return new Error(
    `Unknown provider "${provider}" in "${spec}". Supported: openai, anthropic, google (gemini).${hint}`,
  );
}

type ChatMessages = NonNullable<Parameters<typeof chat>[0]["messages"]>;

/** AG-UI user content (text or multimodal parts) in TanStack AI's content format. */
function convertUserContent(content: unknown) {
  if (!content) return null;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: unknown[] = [];
  for (const part of content as Record<string, unknown>[]) {
    if (!part || typeof part !== "object" || !("type" in part)) continue;
    switch (part.type) {
      case "text":
        if (part.text != null) parts.push({ type: "text", content: part.text });
        break;
      case "image":
      case "audio":
      case "video":
      case "document": {
        const source = part.source as
          | { type: string; value: string; mimeType?: string }
          | undefined;
        if (source?.type === "data")
          parts.push({
            type: part.type,
            source: { type: "data", value: source.value, mimeType: source.mimeType },
          });
        else if (source?.type === "url")
          parts.push({
            type: part.type,
            source: {
              type: "url",
              value: source.value,
              ...(source.mimeType ? { mimeType: source.mimeType } : {}),
            },
          });
        break;
      }
    }
  }
  return parts.length ? parts : "";
}

/** Closes open-ended object schemas, which OpenAI rejects for function tools. */
function closeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(closeSchema);
  if (!schema || typeof schema !== "object") return schema;
  const node = { ...(schema as Record<string, unknown>) };
  if ("additionalProperties" in node) node.additionalProperties = false;
  if (node.properties && typeof node.properties === "object")
    node.properties = Object.fromEntries(
      Object.entries(node.properties).map(([key, value]) => [key, closeSchema(value)]),
    );
  if ("items" in node) node.items = closeSchema(node.items);
  for (const combinator of ["anyOf", "allOf", "oneOf"])
    if (Array.isArray(node[combinator])) node[combinator] = node[combinator].map(closeSchema);
  return node;
}

/** Turns an AG-UI run input into TanStack AI messages, system prompts and client tools. */
export function convertInput(input: RunAgentInput) {
  const messages = input.messages
    .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")
    .map((m) => {
      const message: Record<string, unknown> = {
        role: m.role,
        content:
          m.role === "user"
            ? convertUserContent(m.content)
            : typeof m.content === "string"
              ? m.content
              : null,
      };
      if (m.role === "assistant" && m.toolCalls)
        message.toolCalls = m.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.function.name, arguments: call.function.arguments },
        }));
      if (m.role === "tool") message.toolCallId = m.toolCallId;
      return message;
    }) as unknown as ChatMessages;
  const systemPrompts: string[] = [];
  for (const m of input.messages)
    if ((m.role === "system" || m.role === "developer") && m.content)
      systemPrompts.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
  return {
    messages,
    systemPrompts,
    tools: (input.tools ?? []).map((tool) =>
      toolDefinition({
        name: tool.name,
        description: tool.description,
        inputSchema: closeSchema(tool.parameters) as SchemaInput,
      }),
    ),
  };
}

/**
 * Converts a TanStack AI stream into AG-UI message and tool events. Run lifecycle events are
 * emitted by the caller. All text of one run shares a message ID; splitTextAtToolCalls splits it.
 */
async function* convertStream(stream: AsyncIterable<unknown>, signal: AbortSignal) {
  const messageId = randomUUID();
  const started = new Set<string>();
  const ended = new Set<string>();
  for await (const chunk of stream) {
    if (signal.aborted) break;
    const raw = chunk as Record<string, unknown> & {
      toolCallId: string;
      toolCallName: string;
      delta: string;
    };
    switch (raw.type) {
      case "RUN_ERROR":
        throw new Error(typeof raw.message === "string" ? raw.message : "Model run error");
      case "TEXT_MESSAGE_CONTENT":
        if (raw.delta != null)
          yield {
            type: EventType.TEXT_MESSAGE_CHUNK,
            role: "assistant",
            messageId,
            delta: raw.delta,
          } as BaseEvent;
        break;
      case "TOOL_CALL_START":
        if (started.has(raw.toolCallId)) break;
        started.add(raw.toolCallId);
        yield {
          type: EventType.TOOL_CALL_START,
          parentMessageId: messageId,
          toolCallId: raw.toolCallId,
          toolCallName: raw.toolCallName,
        } as BaseEvent;
        break;
      case "TOOL_CALL_ARGS":
        if (ended.has(raw.toolCallId)) break;
        yield {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: raw.toolCallId,
          delta: raw.delta,
        } as BaseEvent;
        break;
      case "TOOL_CALL_END":
        if (ended.has(raw.toolCallId)) break;
        ended.add(raw.toolCallId);
        yield { type: EventType.TOOL_CALL_END, toolCallId: raw.toolCallId } as BaseEvent;
        break;
      case "TOOL_CALL_RESULT": {
        const payload = raw.content ?? raw.result;
        let content: string;
        if (typeof payload === "string") content = payload;
        else
          try {
            content = JSON.stringify(payload ?? null);
          } catch {
            content = "[Unserializable tool result]";
          }
        yield {
          type: EventType.TOOL_CALL_RESULT,
          role: "tool",
          messageId: randomUUID(),
          toolCallId: raw.toolCallId,
          content,
        } as BaseEvent;
        break;
      }
    }
  }
}

/**
 * The built-in agent: one TanStack AI chat loop per run, streamed as AG-UI events. A run emits
 * RUN_STARTED, message/tool events, then RUN_FINISHED; a failure emits RUN_ERROR and errors the
 * observable. abortRun() ends the run quietly.
 */
export class TanStackAgent extends AbstractAgent {
  private abortController?: AbortController;
  constructor(
    private readonly options: {
      model: string;
      maxSteps: number;
      tools: ToolDefinition[];
      prompt: string;
      /** Said when the step limit, not the model, ends a run; otherwise the reply just stops. */
      stepLimitNote?: string;
    },
  ) {
    super({ agentId: "default" });
  }
  clone(): TanStackAgent {
    return new TanStackAgent(this.options);
  }
  abortRun() {
    this.abortController?.abort();
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    const events = splitTextAtToolCalls(this.runOnce(input));
    return this.options.stepLimitNote
      ? reportStepLimit(events, this.options.maxSteps, this.options.stepLimitNote)
      : events;
  }
  private runOnce(input: RunAgentInput): Observable<BaseEvent> {
    if (this.abortController)
      throw new Error("Agent is already running. Call abortRun() first or create a new instance.");
    const controller = new AbortController();
    this.abortController = controller;
    const { options } = this;
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      void (async () => {
        try {
          const converted = convertInput(input);
          // Build the system prompt: the app prompt, then context entries and any shared state.
          let system = options.prompt;
          for (const prompt of converted.systemPrompts) system += `\n${prompt}`;
          if (input.context?.length) {
            system += "\n## Context from the application\n";
            for (const ctx of input.context) system += `${ctx.description}:\n${ctx.value}\n`;
          }
          const stream = chat({
            adapter: adapter(options.model),
            messages: converted.messages,
            systemPrompts: system ? [system] : [],
            tools: [
              ...converted.tools,
              ...options.tools.map((tool) =>
                toolDefinition({
                  name: tool.name,
                  description: tool.description,
                  inputSchema: tool.parameters as SchemaInput,
                }).server((args) => tool.execute(args as never)),
              ),
            ],
            agentLoopStrategy: maxIterations(options.maxSteps),
            abortController: controller,
          });
          for await (const event of convertStream(stream, controller.signal))
            subscriber.next(event);
          if (!controller.signal.aborted)
            subscriber.next({
              type: EventType.RUN_FINISHED,
              threadId: input.threadId,
              runId: input.runId,
            } as BaseEvent);
          subscriber.complete();
        } catch (error) {
          if (controller.signal.aborted) subscriber.complete();
          else {
            subscriber.next({
              type: EventType.RUN_ERROR,
              message: error instanceof Error ? error.message : String(error),
              threadId: input.threadId,
              runId: input.runId,
            } as BaseEvent);
            subscriber.error(error);
          }
        } finally {
          if (this.abortController === controller) this.abortController = undefined;
        }
      })();
      return () => controller.abort();
    });
  }
}

/** Kept as a function so call sites read like before: one agent per turn. */
export function tanstackAgent(options: ConstructorParameters<typeof TanStackAgent>[0]) {
  return new TanStackAgent(options);
}

/**
 * maxIterations ends the loop after the last allowed tool step without a final model reply.
 * When a run ends that way, add a short assistant message so it does not stop silently.
 */
export function reportStepLimit(events: Observable<BaseEvent>, maxSteps: number, note: string) {
  let steps = 0;
  let phase: "text" | "calling" | "results" = "text";
  return events.pipe(
    mergeMap((event): BaseEvent[] => {
      if (event.type === EventType.TOOL_CALL_START) {
        // Parallel calls of one model step arrive together; results end the step.
        if (phase !== "calling") steps++;
        phase = "calling";
      } else if (event.type === EventType.TOOL_CALL_RESULT) phase = "results";
      else if (event.type === EventType.TEXT_MESSAGE_CHUNK) phase = "text";
      else if (event.type === EventType.RUN_FINISHED && phase === "results" && steps >= maxSteps)
        return [
          {
            type: EventType.TEXT_MESSAGE_CHUNK,
            messageId: randomUUID(),
            role: "assistant",
            delta: note,
          } as BaseEvent,
          event,
        ];
      return [event];
    }),
  );
}

// All text of a run is streamed under one message ID. Text after a tool call gets a new message
// ID, so each step's text is a separate message.
function splitTextAtToolCalls(events: Observable<BaseEvent>) {
  let messageId: string | undefined;
  let afterToolCall = false;
  return events.pipe(
    map((event) => {
      if (event.type === EventType.TEXT_MESSAGE_CHUNK) {
        if (!messageId || afterToolCall) messageId = randomUUID();
        afterToolCall = false;
        return { ...event, messageId };
      }
      if (event.type === EventType.TOOL_CALL_START) {
        afterToolCall = true;
        return messageId ? { ...event, parentMessageId: messageId } : event;
      }
      if (event.type === EventType.TOOL_CALL_RESULT) afterToolCall = true;
      return event;
    }),
  );
}
