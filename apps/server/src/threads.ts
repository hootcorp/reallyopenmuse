import { randomUUID } from "node:crypto";
import { type Message, MessageSchema } from "@ag-ui/core";
import { z } from "zod";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

/** Side chats and the main chat, stored in the workspace database and scoped by owner. */
export interface ThreadSummary {
  id: string;
  name: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

const threadIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid conversation ID");
const MAX_MESSAGES = 1000;
const MAX_NAME = 120;

export const threadPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_NAME).optional(),
    archived: z.boolean().optional(),
  })
  .refine((value) => value.name !== undefined || value.archived !== undefined, {
    message: "Nothing to update",
  });

function titleFrom(messages: Message[]) {
  const first = messages.find((m) => m.role === "user" && typeof m.content === "string");
  const text = typeof first?.content === "string" ? first.content.replace(/\s+/g, " ").trim() : "";
  return text ? text.slice(0, 60) : null;
}

export class ThreadService {
  constructor(private readonly db: Store) {}

  /** The main chat keeps one stable thread ID. Its messages stay in `conversations/default`. */
  async main(owner: string) {
    await this.db.insertIfAbsent(owner, "conversation-settings", {
      id: "main",
      threadId: randomUUID(),
      existing: false,
    });
    const main = await this.db.get<{ threadId: string }>(owner, "conversation-settings", "main");
    if (!main) throw new AppError("Main conversation could not be loaded", 503);
    return { threadId: main.threadId, existing: true };
  }

  async list(
    owner: string,
    options: { includeArchived: boolean; limit: number; cursor?: string },
  ): Promise<{ threads: ThreadSummary[]; nextCursor: string | null }> {
    const main = await this.main(owner);
    const all = (await this.db.list<ThreadSummary>(owner, "threads"))
      .filter((thread) => thread.id !== main.threadId)
      .filter((thread) => options.includeArchived || !thread.archived)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const offset = options.cursor ? Number(options.cursor) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw new AppError("Invalid cursor", 422);
    const page = all.slice(offset, offset + options.limit);
    return {
      threads: page,
      nextCursor: offset + page.length < all.length ? String(offset + page.length) : null,
    };
  }

  async messages(owner: string, id: string): Promise<{ messages: Message[] }> {
    threadIdSchema.parse(id);
    if (id === (await this.main(owner)).threadId)
      return (
        (await this.db.get<{ messages: Message[] }>(owner, "conversations", "default")) ?? {
          messages: [],
        }
      );
    return (
      (await this.db.get<{ messages: Message[] }>(owner, "thread-messages", id)) ?? {
        messages: [],
      }
    );
  }

  async save(owner: string, id: string, input: unknown[]) {
    threadIdSchema.parse(id);
    const messages = z.array(z.unknown()).max(MAX_MESSAGES).parse(input);
    // Store what the client sent once it validates, so fields this schema does not know survive.
    for (const message of messages)
      if (!MessageSchema.safeParse(message).success)
        throw new AppError("A conversation message is not valid", 422);
    const parsed = messages as Message[];
    if (id === (await this.main(owner)).threadId) {
      await this.db.put(owner, "conversations", { id: "default", messages: parsed });
      return;
    }
    const now = new Date().toISOString();
    const existing = await this.db.get<ThreadSummary>(owner, "threads", id);
    await this.db.put(owner, "thread-messages", { id, messages: parsed });
    await this.db.put<ThreadSummary>(owner, "threads", {
      id,
      name: existing?.name ?? titleFrom(parsed),
      archived: existing?.archived ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async update(owner: string, id: string, patch: z.infer<typeof threadPatchSchema>) {
    threadIdSchema.parse(id);
    const existing = await this.db.get<ThreadSummary>(owner, "threads", id);
    if (!existing) throw new AppError("Conversation not found", 404);
    return this.db.put<ThreadSummary>(owner, "threads", {
      ...existing,
      name: patch.name ?? existing.name,
      archived: patch.archived ?? existing.archived,
    });
  }
}
