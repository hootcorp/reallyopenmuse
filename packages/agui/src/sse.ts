/** Incremental parser for a server-sent event stream; yields the JSON payload of each event. */
export class SseParser {
  private buffer = "";
  private invalid = 0;
  /**
   * @param onError Called with the parse error and the raw data of each frame that is not valid
   * JSON. Such a frame is skipped; the frames around it are still returned.
   */
  constructor(private readonly onError?: (error: unknown, data: string) => void) {}
  /** How many frames were skipped so far because their data was not valid JSON. */
  get invalidFrames() {
    return this.invalid;
  }
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
      try {
        events.push(JSON.parse(data));
      } catch (error) {
        // One bad frame must not discard the valid events of the same chunk.
        this.invalid++;
        try {
          this.onError?.(error, data);
        } catch {}
      }
    }
    return events;
  }
}
