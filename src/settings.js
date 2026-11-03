// The user's own Anthropic API key (ADR 0002: no backend). Stored only in this
// browser's extension storage (chrome.storage.local); never synced or sent
// anywhere except api.anthropic.com when the user clicks Prepare.
// Storage is passed in, so this also loads under Node for tests.
(() => {
  "use strict";

  const API_KEY_STORAGE_KEY = "anthropicApiKey";
  const API_KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]+$/;

  const MISSING_KEY_MESSAGE =
    "Prepare needs your own Anthropic API key. Open Cue's options (Extensions menu → Cue → Options, " +
    "or chrome://extensions → Cue → Details → Extension options) and paste a key from platform.claude.com/settings/keys.";

  // Returns { ok: true, key } or { ok: false, message } for what the user typed.
  function normalizeApiKey(input) {
    const key = String(input ?? "").trim();
    if (!key) return { ok: false, message: "Paste an API key first." };
    if (!API_KEY_PATTERN.test(key)) {
      return { ok: false, message: "That doesn't look like an Anthropic API key (they start with sk-ant-)." };
    }
    return { ok: true, key };
  }

  // Enough to recognize which key is saved without revealing it.
  function maskApiKey(key) {
    if (!key) return "";
    if (key.length < 16) return "••••••••";
    return `${key.slice(0, 7)}…${key.slice(-4)}`;
  }

  async function loadApiKey(area) {
    const stored = await area.get(API_KEY_STORAGE_KEY);
    const key = stored?.[API_KEY_STORAGE_KEY];
    return typeof key === "string" && key ? key : null;
  }

  async function saveApiKey(area, input) {
    const result = normalizeApiKey(input);
    if (!result.ok) return result;
    await area.set({ [API_KEY_STORAGE_KEY]: result.key });
    return result;
  }

  async function clearApiKey(area) {
    await area.remove(API_KEY_STORAGE_KEY);
  }

  const api = {
    API_KEY_STORAGE_KEY,
    MISSING_KEY_MESSAGE,
    normalizeApiKey,
    maskApiKey,
    loadApiKey,
    saveApiKey,
    clearApiKey,
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.CueSettings ??= Object.freeze(api);
})();
