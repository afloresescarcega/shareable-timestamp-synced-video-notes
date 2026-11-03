// Prepare: reads a Video's whole Transcript once, up front, and produces its
// Draft. A small state machine with its dependencies passed in, so the panel
// only renders state and tests can check exactly when the API is called.
//
//   const prepare = createPrepare({ getApiKey, fetchImpl, onChange });
//   prepare.start(sourceMaterial)   user clicked Prepare
//   prepare.confirm()               user accepted a cost above the threshold
//   prepare.cancel()                user declined, or stopped generation
//   prepare.reset()                 the Video changed
//   prepare.supersede()             the Notes were replaced (imported): a Prepare
//                                   still starting, awaiting confirmation or
//                                   generating is stopped, and its Draft is never
//                                   produced, so it can't merge into the import
//
// state.phase is one of:
//   idle | needs-key | confirm | generating | done | cancelled | error
(() => {
  "use strict";

  const load = (path, name) =>
    typeof module === "object" && module.exports ? require(path) : globalThis[name];
  const anthropic = load("./anthropic.js", "CueAnthropic");
  const costEstimate = load("./cost-estimate.js", "CueCostEstimate");
  const draftModule = load("./draft.js", "CueDraft");
  const settings = load("./settings.js", "CueSettings");

  // Whether Prepare can run for this source material, and why not.
  function availability(material) {
    if (!material) return { enabled: false, reason: "Open a Video to prepare its Cues." };
    switch (material.status) {
      case "ready":
        return { enabled: true, reason: "" };
      case "loading":
        return { enabled: false, reason: "Waiting for the Transcript…" };
      default:
        return { enabled: false, reason: material.message ?? "There's no Transcript to prepare from." };
    }
  }

  // Prompt and cost estimate for ready source material.
  function plan(material) {
    const prompt = draftModule.buildPrompt(material);
    const estimate = costEstimate.estimateCost({
      inputChars: prompt.inputChars,
      model: anthropic.API.model,
      maxOutputTokens: anthropic.API.maxTokens,
    });
    return { prompt, estimate };
  }

  function createPrepare({ getApiKey, fetchImpl, onChange = () => {}, now = () => new Date() }) {
    let state = { phase: "idle" };
    let pending = null; // { material, apiKey, plan } awaiting confirmation
    let run = null; // { controller } for the generation in flight
    let startToken = 0; // invalidates an in-progress start() after reset/cancel

    const set = (next) => {
      state = next;
      onChange(state);
    };

    async function start(material) {
      if (state.phase === "generating") return;
      const token = ++startToken;
      pending = null;
      const { enabled, reason } = availability(material);
      if (!enabled) return set({ phase: "error", error: { kind: "unavailable", message: reason } });

      let apiKey;
      try {
        apiKey = await getApiKey();
      } catch (error) {
        if (token !== startToken) return;
        return set({ phase: "error", videoId: material.videoId, error: { kind: "settings", message: `Couldn't read Cue's settings: ${error.message}. Reload the page and try again.` } });
      }
      if (token !== startToken) return;
      if (!apiKey) return set({ phase: "needs-key", videoId: material.videoId, message: settings.MISSING_KEY_MESSAGE });

      const p = plan(material);
      if (p.estimate.needsConfirmation) {
        pending = { material, apiKey, plan: p };
        return set({ phase: "confirm", videoId: material.videoId, estimate: p.estimate });
      }
      return generate(material, apiKey, p);
    }

    function confirm() {
      if (state.phase !== "confirm" || !pending) return;
      const { material, apiKey, plan: p } = pending;
      pending = null;
      return generate(material, apiKey, p);
    }

    async function generate(material, apiKey, { prompt, estimate }) {
      const controller = new AbortController();
      const current = { controller };
      run = current;
      const base = { videoId: material.videoId, estimate };
      set({ phase: "generating", ...base, progress: { outputTokens: 0 } });
      try {
        const message = await anthropic.sendMessage({
          fetchImpl,
          apiKey,
          system: prompt.system,
          userContent: prompt.userContent,
          schema: prompt.schema,
          signal: controller.signal,
          onProgress: (acc) => {
            if (run === current) set({ phase: "generating", ...base, progress: { outputTokens: acc.outputTokens } });
          },
        });
        if (run !== current) return;
        let draft;
        try {
          draft = draftModule.parseDraft(message.text, material, {
            createdAt: now().toISOString(),
            model: message.model ?? anthropic.API.model,
            inputTokens: message.inputTokens,
            outputTokens: message.outputTokens,
          });
        } catch (error) {
          throw new anthropic.PrepareError("invalid-response", "Claude's answer couldn't be read as a Draft. Try Prepare again.", { cause: error });
        }
        run = null;
        set({ phase: "done", ...base, draft });
      } catch (error) {
        if (run !== current) return; // cancelled or superseded; state already updated
        run = null;
        if (error?.name === "AbortError") return set({ phase: "cancelled", ...base, message: CANCELLED_MESSAGE });
        const kind = error instanceof anthropic.PrepareError ? error.kind : "unknown";
        if (kind === "unknown") console.warn("[Cue]", error);
        set({ phase: "error", ...base, error: { kind, message: error.message || "Prepare failed." } });
      }
    }

    function cancel() {
      startToken++;
      if (state.phase === "confirm") {
        pending = null;
        return set({ phase: "cancelled", videoId: state.videoId, estimate: state.estimate, message: "Prepare cancelled. Nothing was sent to Anthropic." });
      }
      if (state.phase === "generating" && run) {
        const { controller } = run;
        run = null;
        controller.abort();
        return set({ phase: "cancelled", videoId: state.videoId, estimate: state.estimate, message: CANCELLED_MESSAGE });
      }
    }

    // Import wins over a Prepare that hasn't finished. A finished Draft is left
    // as it is; the panel records it as already handled, so it isn't merged
    // into the imported Notes either.
    function supersede() {
      startToken++; // a start() still reading the key never continues
      if (state.phase === "confirm") {
        pending = null;
        return set({ phase: "cancelled", videoId: state.videoId, estimate: state.estimate, message: SUPERSEDED_BEFORE_SENDING });
      }
      if (state.phase === "generating" && run) {
        const { controller } = run;
        run = null; // a response still arriving is ignored, even if it can't be aborted
        controller.abort();
        return set({ phase: "cancelled", videoId: state.videoId, estimate: state.estimate, message: SUPERSEDED_WHILE_GENERATING });
      }
    }

    function reset() {
      startToken++;
      pending = null;
      if (run) {
        run.controller.abort();
        run = null;
      }
      if (state.phase !== "idle") set({ phase: "idle" });
    }

    return {
      get state() {
        return state;
      },
      start,
      confirm,
      cancel,
      supersede,
      reset,
    };
  }

  const CANCELLED_MESSAGE =
    "Prepare cancelled. Anthropic may still bill for the part of the Draft generated before you cancelled.";

  const SUPERSEDED_BEFORE_SENDING = "Prepare cancelled because Notes were imported. Nothing was sent to Anthropic.";
  const SUPERSEDED_WHILE_GENERATING =
    "Prepare stopped because Notes were imported; its Draft won't be merged into them. Anthropic may still bill for the part generated before it stopped.";

  const api = { availability, plan, createPrepare };

  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.CuePrepare ??= Object.freeze(api);
})();
