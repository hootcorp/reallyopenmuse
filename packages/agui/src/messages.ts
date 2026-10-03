/**
 * The subset of AG-UI messages and events the OpenMuse chat uses, and the pure reducer that
 * folds a stream of events into a message list. It has no dependencies, so the same code runs
 * in React Native, in the browser and in Node tests.
 */
export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
export type UserMessage = { id: string; role: "user" | "system" | "developer"; content: string };
export type AssistantMessage = {
  id: string;
  role: "assistant";
  content?: string;
  toolCalls?: ToolCall[];
};
export type ToolMessage = { id: string; role: "tool"; content: string; toolCallId: string };
export type Message = UserMessage | AssistantMessage | ToolMessage;

export type AguiEvent = { type: string } & Record<string, unknown>;

const text = (value: unknown) => (typeof value === "string" ? value : "");
const id = (value: unknown, fallback: string) =>
  typeof value === "string" && value ? value : fallback;

function randomId() {
  const bytes = new Uint8Array(16);
  const random = globalThis.crypto?.getRandomValues?.(bytes);
  if (!random) for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
export const newId = () => randomId();

/** Appends `delta` to the content of the assistant message `messageId`, creating it if needed. */
function appendText(messages: Message[], messageId: string, delta: string): Message[] {
  const index = messages.findIndex((m) => m.id === messageId);
  if (index < 0) return [...messages, { id: messageId, role: "assistant", content: delta }];
  const message = messages[index];
  if (message.role !== "assistant") return messages;
  const next = messages.slice();
  next[index] = { ...message, content: (message.content ?? "") + delta };
  return next;
}

/** The assistant message a tool call belongs to: its parent, else the trailing assistant message. */
function toolParent(messages: Message[], parentId: string | undefined) {
  if (parentId) {
    const found = messages.findIndex((m) => m.id === parentId);
    if (found >= 0 && messages[found].role === "assistant") return found;
    return -1;
  }
  const last = messages.length - 1;
  return last >= 0 && messages[last].role === "assistant" ? last : -1;
}

function startToolCall(
  messages: Message[],
  event: AguiEvent,
  name: string,
  callId: string,
): Message[] {
  const parentId = typeof event.parentMessageId === "string" ? event.parentMessageId : undefined;
  const call: ToolCall = { id: callId, type: "function", function: { name, arguments: "" } };
  const index = toolParent(messages, parentId);
  if (index < 0)
    return [
      ...messages,
      { id: parentId ?? `message-${callId}`, role: "assistant", content: "", toolCalls: [call] },
    ];
  const parent = messages[index] as AssistantMessage;
  if (parent.toolCalls?.some((existing) => existing.id === callId)) return messages;
  const next = messages.slice();
  next[index] = { ...parent, toolCalls: [...(parent.toolCalls ?? []), call] };
  return next;
}

function appendToolArguments(messages: Message[], callId: string, delta: string): Message[] {
  return messages.map((message) =>
    message.role === "assistant" && message.toolCalls?.some((call) => call.id === callId)
      ? {
          ...message,
          toolCalls: message.toolCalls.map((call) =>
            call.id === callId
              ? {
                  ...call,
                  function: { ...call.function, arguments: call.function.arguments + delta },
                }
              : call,
          ),
        }
      : message,
  );
}

/** Applies one AG-UI event. Events that do not change the transcript return the same array. */
export function applyEvent(messages: Message[], event: AguiEvent): Message[] {
  switch (event.type) {
    case "TEXT_MESSAGE_START": {
      const messageId = id(event.messageId, newId());
      return messages.some((m) => m.id === messageId)
        ? messages
        : [...messages, { id: messageId, role: "assistant", content: "" }];
    }
    case "TEXT_MESSAGE_CONTENT":
    case "TEXT_MESSAGE_CHUNK": {
      const delta = text(event.delta);
      const last = messages[messages.length - 1];
      const messageId =
        typeof event.messageId === "string" && event.messageId
          ? event.messageId
          : last?.role === "assistant"
            ? last.id
            : newId();
      return delta ? appendText(messages, messageId, delta) : messages;
    }
    case "TOOL_CALL_START":
      return startToolCall(messages, event, text(event.toolCallName), text(event.toolCallId));
    case "TOOL_CALL_ARGS":
      return appendToolArguments(messages, text(event.toolCallId), text(event.delta));
    case "TOOL_CALL_CHUNK": {
      const callId = text(event.toolCallId);
      let next = messages;
      const known = messages.some(
        (m) => m.role === "assistant" && m.toolCalls?.some((call) => call.id === callId),
      );
      if (!known && callId && event.toolCallName)
        next = startToolCall(messages, event, text(event.toolCallName), callId);
      return event.delta ? appendToolArguments(next, callId, text(event.delta)) : next;
    }
    case "TOOL_CALL_RESULT": {
      const messageId = id(event.messageId, newId());
      if (messages.some((m) => m.id === messageId)) return messages;
      return [
        ...messages,
        {
          id: messageId,
          role: "tool",
          toolCallId: text(event.toolCallId),
          content: text(event.content),
        },
      ];
    }
    case "MESSAGES_SNAPSHOT":
      return Array.isArray(event.messages) ? (event.messages as Message[]) : messages;
    default:
      return messages;
  }
}

/** Parses tool-call arguments that may still be streaming; unfinished JSON gives {}. */
export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
