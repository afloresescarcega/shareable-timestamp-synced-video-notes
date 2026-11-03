// Cost estimate shown before Prepare. Pure; loads under Node for tests.
// Prices are Anthropic's first-party rates per million tokens
// (https://platform.claude.com/docs/en/about-claude/pricing, checked 2026-11-02).
(() => {
  "use strict";

  const PRICING_USD_PER_MTOK = Object.freeze({
    "claude-opus-5-5": Object.freeze({ input: 4, output: 20 }),
    "claude-sonnet-5-5": Object.freeze({ input: 2, output: 10 }),
  });

  // Above this, Prepare asks before spending; at or below, it just runs.
  const CONFIRM_ABOVE_USD = 0.5;

  // Deliberately pessimistic: current Claude tokenizers average under 4 chars
  // per token for English, and timestamps tokenize densely.
  const CHARS_PER_TOKEN = 3;
  // Structured-output and request framing the character count doesn't see.
  const INPUT_OVERHEAD_TOKENS = 1000;
  // Output is thinking plus the JSON Draft; both grow with the Transcript.
  const OUTPUT_BASE_TOKENS = 4000;
  const OUTPUT_PER_INPUT_TOKEN = 0.5;

  function estimateCost({ inputChars, model, maxOutputTokens }) {
    const price = PRICING_USD_PER_MTOK[model];
    if (!price) throw new Error(`No pricing for model ${model}`);
    const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN) + INPUT_OVERHEAD_TOKENS;
    const outputTokens = Math.min(
      maxOutputTokens,
      Math.ceil(OUTPUT_BASE_TOKENS + inputTokens * OUTPUT_PER_INPUT_TOKEN)
    );
    const usd = (inputTokens * price.input + outputTokens * price.output) / 1e6;
    return { model, inputTokens, outputTokens, usd, needsConfirmation: usd > CONFIRM_ABOVE_USD };
  }

  function formatUsd(usd) {
    if (usd < 0.01) return "under $0.01";
    return `$${usd.toFixed(2)}`;
  }

  const api = { PRICING_USD_PER_MTOK, CONFIRM_ABOVE_USD, CHARS_PER_TOKEN, estimateCost, formatUsd };

  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.CueCostEstimate ??= Object.freeze(api);
})();
