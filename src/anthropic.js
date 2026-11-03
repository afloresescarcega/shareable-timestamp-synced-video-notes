// Anthropic Messages API access for Prepare, called straight from the content
// script with the user's own key (ADR 0002). Plain fetch rather than the SDK
// because the extension ships unbundled scripts.
//
// Docs this follows (checked 2026-11-02):
//   Messages API      https://platform.claude.com/docs/en/api/messages
//   API versions      https://platform.claude.com/docs/en/api/versioning
//   Structured output https://platform.claude.com/docs/en/build-with-claude/structured-outputs
//   Errors            https://platform.claude.com/docs/en/api/errors
//   Browser header    what the official SDK sends with dangerouslyAllowBrowser
//                     (anthropic-sdk-typescript src/client.ts)
//
// Security boundary (reviewed 2026-11-02). The key is the user's own and the
// call goes straight to Anthropic (ADR 0002: no backend). What protects it:
//   - It's read from chrome.storage.local only when the user clicks Prepare,
//     kept in the content script's isolated world (YouTube's page scripts
//     can't read its variables), never put in the DOM, logged, or written
//     into Notes or exported files, and sent only to API.url below.
//   - The request carries no cookies, no Referer (Anthropic isn't told which
//     Video page asked), isn't cached, and refuses redirects, so the
//     x-api-key header can't follow a redirect anywhere else.
//   - Prepare and its cost confirmation only start from a real user click
//     (src/user-action.js), so a page script can't spend the user's money.
// What remains: the content script runs in youtube.com's renderer process,
// so a compromised youtube.com renderer could read the key while Prepare
// runs, and content scripts can read chrome.storage.local (where the key
// lives) at any time. Moving the call into an MV3 service worker would keep
// the key out of that process only if the key were also hidden from content
// scripts (chrome.storage.local.setAccessLevel), which would cut the content
// script off from the saved Notes it keeps in the same area, and the service
// worker would have to stay alive for a multi-minute stream it is not
// guaranteed to outlive. Not done for v1; revisit together with where Notes
// are stored.
(() => {
  "use strict";

  // Everything that tracks Anthropic's API lives here; update it in one place.
  const API = Object.freeze({
    url: "https://api.anthropic.com/v1/messages",
    version: "2026-10-21",
    model: "claude-opus-5-5",
    // Opus 5.5 always thinks; effort is the only depth/cost control (its default is "medium").
    effort: "medium",
    // Streaming, so a long Draft can't hit request timeouts; thinking counts against this.
    maxTokens: 64000,
    // On a safety-classifier refusal, re-run on Anthropic's recommended model for that category.
    fallbacks: "default",
    betas: Object.freeze(["server-side-fallback-2026-07-01"]),
  });

  class PrepareError extends Error {
    // kind: auth | permission | billing | not-found | rate-limit | overloaded | too-large |
    //       bad-request | server | network | refusal | truncated | invalid-response
    constructor(kind, message, details = {}) {
      super(message);
      this.name = "PrepareError";
      this.kind = kind;
      this.details = details;
    }
  }

  function buildHeaders(apiKey) {
    return {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": API.version,
      // Required for CORS: Anthropic only answers browser requests that opt in.
      "anthropic-dangerous-direct-browser-access": "true",
      ...(API.betas.length ? { "anthropic-beta": API.betas.join(",") } : {}),
    };
  }

  function buildBody({ system, userContent, schema }) {
    return {
      model: API.model,
      max_tokens: API.maxTokens,
      stream: true,
      system,
      messages: [{ role: "user", content: userContent }],
      output_config: {
        effort: API.effort,
        format: { type: "json_schema", schema },
      },
      fallbacks: API.fallbacks,
    };
  }

  // Returns the [url, init] pair for fetch().
  function buildRequest({ apiKey, system, userContent, schema, signal }) {
    if (!apiKey) throw new PrepareError("auth", "No API key.");
    return [
      API.url,
      {
        method: "POST",
        headers: buildHeaders(apiKey),
        body: JSON.stringify(buildBody({ system, userContent, schema })),
        signal,
        credentials: "omit", // no cookies
        referrerPolicy: "no-referrer", // don't reveal the YouTube page (and Video) that asked
        redirect: "error", // the key header must never follow a redirect to another host
        cache: "no-store",
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Errors

  function errorFromApi({ status, type, message, retryAfterSeconds }) {
    const said = message ? ` Anthropic said: ${message}` : "";
    const details = { status, type, message, retryAfterSeconds };
    if (status === 401 || type === "authentication_error") {
      return new PrepareError("auth", "Anthropic didn't accept your API key. Check or replace it in Cue's options.", details);
    }
    if (status === 403 || type === "permission_error") {
      return new PrepareError("permission", `Your API key isn't allowed to make this request.${said}`, details);
    }
    if (status === 402 || type === "billing_error") {
      return new PrepareError("billing", `Anthropic reported a billing problem with your account.${said}`, details);
    }
    if (status === 404 || type === "not_found_error") {
      return new PrepareError("not-found", `The model ${API.model} isn't available to your API key.${said}`, details);
    }
    if (status === 429 || type === "rate_limit_error") {
      const wait = retryAfterSeconds ? ` Try again in about ${retryAfterSeconds} s.` : " Try again shortly.";
      return new PrepareError("rate-limit", `Your Anthropic rate limit or spend cap was reached.${wait}${said}`, details);
    }
    if (status === 529 || type === "overloaded_error") {
      return new PrepareError("overloaded", "Anthropic is overloaded right now. Try again in a minute.", details);
    }
    if (status === 413 || type === "request_too_large") {
      return new PrepareError("too-large", "This Transcript is too large to send in one request.", details);
    }
    if (status >= 500 || type === "api_error") {
      return new PrepareError("server", `Anthropic had a server error${status ? ` (HTTP ${status})` : ""}. Try again.`, details);
    }
    return new PrepareError("bad-request", `Anthropic rejected the request.${said}`, details);
  }

  // Turns a non-2xx fetch Response into a PrepareError.
  async function errorFromResponse(response) {
    let type = null;
    let message = null;
    try {
      const body = JSON.parse(await response.text());
      type = body?.error?.type ?? null;
      message = body?.error?.message ?? null;
    } catch {
      // Non-JSON body; status alone decides.
    }
    const retryAfter = Number(response.headers?.get?.("retry-after"));
    return errorFromApi({
      status: response.status,
      type,
      message,
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : null,
    });
  }

  // ---------------------------------------------------------------------------
  // Streaming (server-sent events)

  // Incremental SSE parser: feed it text chunks, it calls onEvent({ event, data }).
  function createSseParser(onEvent) {
    let buffer = "";
    let event = null;
    let data = [];
    const dispatch = () => {
      if (data.length) onEvent({ event: event ?? "message", data: data.join("\n") });
      event = null;
      data = [];
    };
    const line = (text) => {
      if (text === "") return dispatch();
      if (text.startsWith(":")) return;
      const colon = text.indexOf(":");
      const field = colon === -1 ? text : text.slice(0, colon);
      let value = colon === -1 ? "" : text.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    };
    return {
      push(chunk) {
        buffer += chunk;
        let newline;
        while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
          const isCrLf = buffer[newline] === "\r" && buffer[newline + 1] === "\n";
          line(buffer.slice(0, newline));
          buffer = buffer.slice(newline + (isCrLf ? 2 : 1));
        }
      },
      end() {
        if (buffer) line(buffer);
        buffer = "";
        dispatch();
      },
    };
  }

  function createMessageAccumulator() {
    return { model: null, text: "", stopReason: null, stopDetails: null, inputTokens: 0, outputTokens: 0 };
  }

  // Folds one parsed SSE event into the accumulator. Text from every text block
  // is joined: after a mid-stream fallback the fallback model continues the
  // partial text, so the concatenation is the whole answer.
  function applyStreamEvent(acc, { event, data }) {
    if (event === "ping") return acc;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new PrepareError("invalid-response", "Anthropic sent a malformed stream event.");
    }
    switch (payload.type) {
      case "message_start": {
        const usage = payload.message?.usage ?? {};
        acc.model = payload.message?.model ?? acc.model;
        acc.inputTokens =
          (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
        acc.outputTokens = usage.output_tokens ?? 0;
        break;
      }
      case "content_block_start":
        if (payload.content_block?.type === "text") acc.text += payload.content_block.text ?? "";
        break;
      case "content_block_delta":
        if (payload.delta?.type === "text_delta") acc.text += payload.delta.text ?? "";
        break;
      case "message_delta":
        acc.stopReason = payload.delta?.stop_reason ?? acc.stopReason;
        acc.stopDetails = payload.delta?.stop_details ?? acc.stopDetails;
        if (payload.usage?.output_tokens != null) acc.outputTokens = payload.usage.output_tokens;
        break;
      case "error":
        throw errorFromApi({ status: null, type: payload.error?.type, message: payload.error?.message });
      default:
        break; // message_stop, content_block_stop, and anything newer
    }
    return acc;
  }

  // Reads a streaming Messages response to the end. onProgress(acc) is called
  // after each chunk. Resolves with the accumulator; rejects with PrepareError,
  // or with the AbortError if the request's signal fires.
  async function readMessageStream(response, { onProgress } = {}) {
    const acc = createMessageAccumulator();
    const parser = createSseParser((event) => applyStreamEvent(acc, event));
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
      onProgress?.(acc);
    }
    parser.push(decoder.decode());
    parser.end();
    return finishMessage(acc);
  }

  function finishMessage(acc) {
    if (acc.stopReason === "refusal") {
      const category = acc.stopDetails?.category;
      throw new PrepareError(
        "refusal",
        `Claude declined to prepare this Video${category ? ` (${category})` : ""}.`,
        { stopDetails: acc.stopDetails }
      );
    }
    if (acc.stopReason === "max_tokens") {
      throw new PrepareError("truncated", "The Draft was cut off before it was complete. Try Prepare again.");
    }
    if (!acc.stopReason) {
      throw new PrepareError("network", "The connection to Anthropic ended before the Draft was complete.");
    }
    return acc;
  }

  // Sends the request and reads the whole streamed message.
  async function sendMessage({ fetchImpl, apiKey, system, userContent, schema, signal, onProgress }) {
    let response;
    try {
      response = await fetchImpl(...buildRequest({ apiKey, system, userContent, schema, signal }));
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new PrepareError("network", "Couldn't reach Anthropic. Check your connection and try again.", { cause: error });
    }
    if (!response.ok) throw await errorFromResponse(response);
    try {
      return await readMessageStream(response, { onProgress });
    } catch (error) {
      if (error?.name === "AbortError" || error instanceof PrepareError) throw error;
      throw new PrepareError("network", "The connection to Anthropic was interrupted. Try again.", { cause: error });
    }
  }

  const api = {
    API,
    PrepareError,
    buildHeaders,
    buildBody,
    buildRequest,
    errorFromApi,
    errorFromResponse,
    createSseParser,
    createMessageAccumulator,
    applyStreamEvent,
    finishMessage,
    readMessageStream,
    sendMessage,
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.CueAnthropic ??= Object.freeze(api);
})();
