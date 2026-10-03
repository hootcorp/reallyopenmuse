import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Agent, fetchTransport } from "../../../packages/agui/src/index.ts";
import { ConversationQueue } from "../src/conversation-queue.ts";

test("a run error stops the queue and holds the remaining messages", async () => {
  let attempts = 0;
  const server = createServer((request, response) => {
    attempts++;
    request.resume();
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end('data: {"type":"RUN_ERROR","message":"Connection interrupted"}\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const agent = new Agent({
      url: `http://127.0.0.1:${address.port}/api/agui/run`,
      threadId: "t",
      headers: () => ({}),
      transport: fetchTransport,
    });
    const queue = new ConversationQueue();
    queue.enqueue({ id: "first", text: "First task" });
    queue.enqueue({ id: "second", text: "Second task" });
    await assert.rejects(
      queue.flush(async (message) => {
        agent.addMessage({ id: message.id, role: "user", content: message.text });
        await agent.run();
      }),
      /Connection interrupted/,
    );
    assert.equal(attempts, 1);
    assert.equal(queue.getSnapshot().paused, true);
    assert.deepEqual(
      queue.getSnapshot().pending.map((message) => message.id),
      ["second"],
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
