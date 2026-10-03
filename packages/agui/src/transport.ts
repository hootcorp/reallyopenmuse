/** Opens a POST request and reports the response body as text while it streams. */
export type StreamRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  onText: (chunk: string) => void;
};
export type StreamResponse = { status: number; errorText: string };
export type Transport = (request: StreamRequest) => Promise<StreamResponse>;

export class StreamAbortError extends Error {
  constructor() {
    super("The request was cancelled");
    this.name = "AbortError";
  }
}

/**
 * XMLHttpRequest streams text progressively in React Native and in browsers, so one code path
 * serves the web and the native app. Nothing here needs a Streams, TextDecoder or Headers polyfill.
 */
export const xhrTransport: Transport = (request) =>
  new Promise((resolve, reject) => {
    if (request.signal.aborted) return reject(new StreamAbortError());
    const xhr = new XMLHttpRequest();
    let read = 0;
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener("abort", onAbort);
      action();
    };
    const pump = () => {
      // Only successful responses carry events; an error body is returned as text instead.
      if (xhr.status < 200 || xhr.status >= 300) return;
      const text = xhr.responseText;
      if (text.length > read) {
        const chunk = text.slice(read);
        read = text.length;
        request.onText(chunk);
      }
    };
    const onAbort = () => {
      finish(() => reject(new StreamAbortError()));
      xhr.abort();
    };
    request.signal.addEventListener("abort", onAbort);
    xhr.open("POST", request.url);
    for (const [name, value] of Object.entries(request.headers)) xhr.setRequestHeader(name, value);
    xhr.responseType = "text";
    xhr.onprogress = () => {
      try {
        pump();
      } catch (error) {
        finish(() => reject(error));
        xhr.abort();
      }
    };
    xhr.onload = () => {
      try {
        pump();
      } catch (error) {
        return finish(() => reject(error));
      }
      finish(() =>
        resolve({ status: xhr.status, errorText: xhr.status >= 300 ? xhr.responseText : "" }),
      );
    };
    xhr.onerror = () => finish(() => reject(new TypeError("Network request failed")));
    xhr.ontimeout = () => finish(() => reject(new TypeError("Network request timed out")));
    xhr.send(request.body);
  });

/** Streaming fetch, for runtimes that have it (Node, modern browsers). */
export const fetchTransport: Transport = async (request) => {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: request.signal,
    });
  } catch (error) {
    if (request.signal.aborted) throw new StreamAbortError();
    throw error;
  }
  if (!response.ok) return { status: response.status, errorText: await response.text() };
  if (!response.body) throw new TypeError("This runtime cannot stream responses");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      request.onText(decoder.decode(value, { stream: true }));
    }
    request.onText(decoder.decode());
  } catch (error) {
    if (request.signal.aborted) throw new StreamAbortError();
    throw error;
  }
  return { status: response.status, errorText: "" };
};

export function defaultTransport(): Transport {
  return typeof XMLHttpRequest !== "undefined" ? xhrTransport : fetchTransport;
}
