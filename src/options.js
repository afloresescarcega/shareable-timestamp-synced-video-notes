// Options page: save, show (masked), and clear the user's Anthropic API key.
(() => {
  "use strict";

  const settings = globalThis.CueSettings;
  const area = chrome.storage.local;
  const form = document.getElementById("api-key-form");
  const input = document.getElementById("api-key");
  const saved = document.getElementById("api-key-saved");
  const clear = document.getElementById("api-key-clear");
  const message = document.getElementById("api-key-message");

  function say(text, state = "") {
    message.textContent = text;
    message.dataset.state = state;
  }

  async function showSaved() {
    const key = await settings.loadApiKey(area);
    saved.textContent = key ? `Saved key: ${settings.maskApiKey(key)}` : "No API key saved.";
    clear.disabled = !key;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await settings.saveApiKey(area, input.value);
    if (!result.ok) return say(result.message, "error");
    input.value = "";
    say("Saved.");
    await showSaved();
  });

  clear.addEventListener("click", async () => {
    await settings.clearApiKey(area);
    input.value = "";
    say("API key cleared.");
    await showSaved();
  });

  showSaved().catch((error) => say(`Couldn't read settings: ${error.message}`, "error"));
})();
