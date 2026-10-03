import "./config.ts";
import { HttpAgent } from "@ag-ui/client";
import { RunAgentInputSchema } from "@ag-ui/core";
import { Hono } from "hono";
import type { Config } from "./config.ts";
import { ConversationAgent } from "./engine/conversation.ts";
import type { AgentService } from "./engine/service.ts";
import { AppError } from "./errors.ts";
import { createJevAdapter, type JevAdapter } from "./jev/adapter.ts";

export function agentConfigured(config: Config) {
  return (
    config.agentBackend === "sample" ||
    (config.agentBackend === "agui"
      ? Boolean(config.agentUrl)
      : Boolean(
          config.model &&
            (process.env.OPENAI_API_KEY ||
              process.env.ANTHROPIC_API_KEY ||
              process.env.GOOGLE_API_KEY),
        ))
  );
}

/**
 * The agent runtime: `POST /run` takes an AG-UI RunAgentInput and streams AG-UI events as
 * server-sent events; `GET /info` describes the agent. A client stops a run by closing the
 * request, which tears down the agent and any browser work it started. Mounted under /api/*,
 * so the authenticated owner is already on the context.
 */
export function agentRuntime(config: Config, service: AgentService) {
  // Built on first use, then shared so live mode reuses one TypeSafe client across requests.
  let jevAdapter: JevAdapter | undefined;
  const sharedJevAdapter = () => (jevAdapter ??= createJevAdapter(config));
  const routes = new Hono<{ Variables: { owner: string } }>();
  const agentFor = (owner: string) =>
    config.agentBackend === "agui"
      ? new HttpAgent({
          url: config.agentUrl ?? "http://127.0.0.1:1/unconfigured",
          headers: config.agentToken ? { Authorization: `Bearer ${config.agentToken}` } : {},
        })
      : new ConversationAgent(config, service, owner, sharedJevAdapter());
  routes.use("*", async (_c, next) => {
    if (!agentConfigured(config))
      throw new AppError(
        "Configure a model and provider API key, or a valid AG-UI endpoint, to start chat",
        503,
      );
    await next();
  });
  routes.get("/info", (c) =>
    c.json({ version: 1, agents: { default: { name: "default", description: "OpenMuse agent" } } }),
  );
  routes.post("/run", async (c) => {
    const parsed = RunAgentInputSchema.safeParse(await c.req.json());
    if (!parsed.success) throw new AppError("The run request is not a valid AG-UI input", 422);
    const input = parsed.data;
    const events = agentFor(c.get("owner")).run(input);
    const encoder = new TextEncoder();
    let subscription: { unsubscribe(): void } | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      clearInterval(ping);
      subscription?.unsubscribe();
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: unknown) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        let ended = false;
        const finish = () => {
          if (ended) return;
          ended = true;
          clearInterval(ping);
          controller.close();
        };
        let terminal = false;
        // Comment lines keep proxies from closing a stream that is quiet while a tool runs.
        ping = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 15000);
        c.req.raw.signal.addEventListener("abort", () => {
          stop();
          finish();
        });
        subscription = events.subscribe({
          next: (event) => {
            if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") terminal = true;
            send(event);
          },
          error: (error) => {
            if (!terminal)
              send({
                type: "RUN_ERROR",
                message: error instanceof Error ? error.message : "The agent run failed",
              });
            finish();
          },
          complete: finish,
        });
      },
      cancel: stop,
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
  return routes;
}
