/** Incremental parser for a server-sent event stream; yields the JSON payload of each event. */
export class SseParser {
  private buffer = "";
  /** Feed text as it arrives; returns the complete events it finished. */
  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const events: unknown[] = [];
    for (;;) {
      const match = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer);
      if (!match) break;
      const block = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const data = block
        .split(/\r\n|\n|\r/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data || data === "[DONE]") continue;
      events.push(JSON.parse(data));
    }
    return events;
  }
}
