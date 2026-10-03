import { type AguiEvent, applyEvent, type Message, newId } from "./messages.ts";
import { SseParser } from "./sse.ts";
import { defaultTransport, type Transport } from "./transport.ts";

export type AgentContext = { description: string; value: string };
export type AgentOptions = {
  /** Full URL of the runtime's run endpoint, for example https://host/api/agui/run. */
  url: string;
  threadId: string;
  headers: () => Record<string, string>;
  context?: () => AgentContext[];
  transport?: Transport;
};

/**
 * One conversation with the OpenMuse agent runtime. It owns the message list, posts it to the
 * run endpoint, folds the streamed AG-UI events back into the list and tells subscribers when
 * anything changed (compatible with React's useSyncExternalStore).
 */
export class Agent {
  private current: Message[] = [];
  private running = false;
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private controller?: AbortController;
  constructor(private readonly options: AgentOptions) {}
  get threadId() {
    return this.options.threadId;
  }
  get messages(): readonly Message[] {
    return this.current;
  }
  get isRunning() {
    return this.running;
  }
  /** Changes whenever the messages or the running state change. */
  getSnapshot = () => this.version;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit() {
    this.version++;
    for (const listener of [...this.listeners]) listener();
  }
  setMessages(messages: Message[]) {
    this.current = messages;
    this.emit();
  }
  addMessage(message: Message) {
    this.current = [...this.current, message];
    this.emit();
  }
  /** Ends the current run without an error; messages received so far are kept. */
  stop() {
    this.controller?.abort();
  }
  /**
   * Runs the agent on the current messages. Resolves when the run finishes or is stopped, and
   * rejects with the failure when the server reports an error or the connection breaks.
   */
  async run(): Promise<void> {
    if (this.running) throw new Error("The agent is already running");
    const controller = new AbortController();
    this.controller = controller;
    this.running = true;
    this.emit();
    const parser = new SseParser();
    let failure: Error | undefined;
    let finished = false;
    const handle = (event: AguiEvent) => {
      if (event.type === "RUN_ERROR") {
        failure = new Error(typeof event.message === "string" ? event.message : "The run failed");
        return;
      }
      if (event.type === "RUN_FINISHED") finished = true;
      const next = applyEvent(this.current, event);
      if (next !== this.current) {
        this.current = next;
        this.emit();
      }
    };
    try {
      const transport = this.options.transport ?? defaultTransport();
      const response = await transport({
        url: this.options.url,
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...this.options.headers(),
        },
        body: JSON.stringify({
          threadId: this.options.threadId,
          runId: newId(),
          state: {},
          messages: this.current,
          tools: [],
          context: this.options.context?.() ?? [],
          forwardedProps: {},
        }),
        signal: controller.signal,
        onText: (chunk) => {
          for (const event of parser.push(chunk)) handle(event as AguiEvent);
        },
      });
      if (response.status < 200 || response.status >= 300) {
        let message = `Request failed (${response.status})`;
        try {
          const payload = JSON.parse(response.errorText);
          if (typeof payload.error === "string") message = payload.error;
        } catch {}
        throw new Error(message);
      }
      if (failure) throw failure;
      if (!finished) throw new Error("Connection interrupted");
    } catch (error) {
      if (controller.signal.aborted) return;
      throw failure ?? (error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.running = false;
      this.controller = undefined;
      this.emit();
    }
  }
}
