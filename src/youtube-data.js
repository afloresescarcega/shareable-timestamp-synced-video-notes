// Pure helpers that read YouTube's watch-page data and normalize the
// Transcript and creator chapters (Sections) of a Video.
// No DOM, network, or extension APIs here, so it also loads under Node for tests.
(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Generic data walking

  // Yields every value stored under `key` anywhere inside `root` (depth-first).
  function findAll(root, key) {
    const found = [];
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(node, key)) found.push(node[key]);
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") stack.push(value);
      }
    }
    return found;
  }

  // YouTube renders text either as { simpleText } or { runs: [{ text }] }.
  function readText(textObject) {
    if (!textObject) return "";
    if (typeof textObject === "string") return textObject;
    if (typeof textObject.simpleText === "string") return textObject.simpleText;
    if (Array.isArray(textObject.runs)) return textObject.runs.map((r) => r.text ?? "").join("");
    return "";
  }

  const cleanText = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

  const toInt = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : null;
  };

  // ---------------------------------------------------------------------------
  // Watch-page HTML parsing

  // Returns the JSON object literal that starts at the first "{" after `marker`,
  // matching braces while respecting strings. Null if not found or unparsable.
  function extractJsonObjectAfter(source, marker) {
    const markerAt = source.indexOf(marker);
    if (markerAt === -1) return null;
    const start = source.indexOf("{", markerAt + marker.length);
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  // Pulls the data YouTube embeds in a watch page's HTML.
  function parseWatchPageHtml(html) {
    const apiKeyMatch = /"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/.exec(html);
    return {
      playerResponse: extractJsonObjectAfter(html, "ytInitialPlayerResponse = "),
      initialData: extractJsonObjectAfter(html, "ytInitialData = "),
      innertube: {
        apiKey: apiKeyMatch ? apiKeyMatch[1] : null,
        context: extractJsonObjectAfter(html, '"INNERTUBE_CONTEXT":'),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Support check

  // Reasons the Video cannot be Prepared because there is no usable Transcript.
  const UNSUPPORTED = Object.freeze({
    NO_TRANSCRIPT: "no-transcript",
    LIVE: "live",
    UNAVAILABLE: "video-unavailable",
  });

  const UNSUPPORTED_MESSAGES = Object.freeze({
    [UNSUPPORTED.NO_TRANSCRIPT]: "This Video has no Transcript, so Cues can't be prepared for it.",
    [UNSUPPORTED.LIVE]: "Live Videos have no Transcript yet, so Cues can't be prepared for them.",
    [UNSUPPORTED.UNAVAILABLE]: "This Video isn't playable here, so its Transcript can't be read.",
  });

  function unsupported(videoId, reason) {
    return { status: "unsupported", videoId, reason, message: UNSUPPORTED_MESSAGES[reason] };
  }

  // Returns an unsupported reason the player response alone reveals, else null.
  function detectUnsupported(playerResponse) {
    if (!playerResponse) return UNSUPPORTED.UNAVAILABLE;
    const playability = playerResponse.playabilityStatus?.status;
    if (playability && playability !== "OK") return UNSUPPORTED.UNAVAILABLE;
    const details = playerResponse.videoDetails ?? {};
    if (details.isLive || details.isUpcoming) return UNSUPPORTED.LIVE;
    return null;
  }

  // Whether loaded source material is settled for its Video and worth reusing:
  // a Transcript that was read, or a player response that clearly lists no
  // caption track and no transcript panel (the Video has no Transcript).
  // Everything else may be passing: a page that couldn't be read, a Video
  // that isn't playable right now (sign-in or bot checks), a live stream that
  // will end, or a network failure. Those are retried on the next load.
  function isSettled(material) {
    if (material?.status === "ready") return true;
    return material?.status === "unsupported" && material.reason === UNSUPPORTED.NO_TRANSCRIPT;
  }

  // ---------------------------------------------------------------------------
  // Transcript

  function getCaptionTracks(playerResponse) {
    const tracks =
      playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    return Array.isArray(tracks) ? tracks.filter((t) => t && t.baseUrl) : [];
  }

  // Picks the track closest to what is actually said: a manual track in the
  // spoken language (the auto-generated track's language) beats the
  // auto-generated one, which beats any other manual track (likely a translation).
  function selectCaptionTrack(tracks) {
    if (!tracks.length) return null;
    const asr = tracks.find((t) => t.kind === "asr");
    const manual = tracks.filter((t) => t.kind !== "asr");
    if (asr) {
      const sameLanguage = manual.find((t) => t.languageCode === asr.languageCode);
      return sameLanguage ?? asr;
    }
    return manual[0] ?? null;
  }

  function describeTrack(track) {
    return {
      languageCode: track?.languageCode ?? null,
      kind: track?.kind === "asr" ? "auto-generated" : "manual",
    };
  }

  // Sorts, drops empty/invalid entries, and fills missing durations from the next start.
  function finalizeEntries(entries) {
    const valid = entries
      .filter((e) => e.text && e.startMs != null && e.startMs >= 0)
      .sort((a, b) => a.startMs - b.startMs);
    return valid.map((entry, i) => {
      let durationMs = entry.durationMs;
      if (durationMs == null || durationMs < 0) {
        const next = valid[i + 1];
        durationMs = next ? Math.max(0, next.startMs - entry.startMs) : 0;
      }
      return { startMs: entry.startMs, durationMs, text: entry.text };
    });
  }

  // Normalizes a timedtext response in `fmt=json3`.
  function normalizeJson3Transcript(json) {
    const events = Array.isArray(json?.events) ? json.events : [];
    return finalizeEntries(
      events
        .filter((event) => Array.isArray(event.segs))
        .map((event) => ({
          startMs: toInt(event.tStartMs),
          durationMs: toInt(event.dDurationMs),
          text: cleanText(event.segs.map((seg) => seg.utf8 ?? "").join("")),
        }))
    );
  }

  // Normalizes a youtubei `get_transcript` response (the "Show transcript" panel).
  function normalizeTranscriptPanel(json) {
    return finalizeEntries(
      findAll(json, "transcriptSegmentRenderer").map((segment) => {
        const startMs = toInt(segment.startMs);
        const endMs = toInt(segment.endMs);
        return {
          startMs,
          durationMs: startMs != null && endMs != null ? endMs - startMs : null,
          text: cleanText(readText(segment.snippet)),
        };
      })
    );
  }

  // The opaque token YouTube's own "Show transcript" button sends to get_transcript.
  function getTranscriptPanelParams(initialData) {
    const endpoint = findAll(initialData, "getTranscriptEndpoint").find((e) => e?.params);
    return endpoint ? endpoint.params : null;
  }

  // ---------------------------------------------------------------------------
  // Sections from creator chapters

  // Converts "1:02:03" / "12:34" to milliseconds.
  function parseTimestamp(text) {
    const parts = cleanText(text).split(":");
    if (!parts.length || parts.some((p) => !/^\d+$/.test(p))) return null;
    return parts.reduce((total, part) => total * 60 + Number(part), 0) * 1000;
  }

  // Sorts chapter starts and gives each Section the span up to the next one
  // (the last runs to the end of the Video when its length is known).
  function buildSections(chapters, videoDurationMs) {
    const starts = chapters
      .filter((c) => c.title && c.startMs != null && c.startMs >= 0)
      .sort((a, b) => a.startMs - b.startMs)
      .filter((c, i, all) => i === 0 || c.startMs !== all[i - 1].startMs);
    return starts.map((chapter, i) => ({
      title: chapter.title,
      startMs: chapter.startMs,
      endMs: starts[i + 1]?.startMs ?? (videoDurationMs > chapter.startMs ? videoDurationMs : null),
      origin: "creator",
    }));
  }

  // Creator chapters from the player bar markers (DESCRIPTION_CHAPTERS only;
  // YouTube's AUTO_CHAPTERS are not the creator's and are ignored).
  function chaptersFromMarkers(initialData) {
    for (const markersMap of findAll(initialData, "markersMap")) {
      if (!Array.isArray(markersMap)) continue;
      const entry = markersMap.find((m) => m?.key === "DESCRIPTION_CHAPTERS");
      const chapters = entry?.value?.chapters;
      if (!Array.isArray(chapters) || !chapters.length) continue;
      return chapters
        .map((c) => c?.chapterRenderer)
        .filter(Boolean)
        .map((c) => ({ title: cleanText(readText(c.title)), startMs: toInt(c.timeRangeStartMillis) }));
    }
    return [];
  }

  // Fallback: the "Chapters" engagement panel built from the description.
  function chaptersFromEngagementPanel(initialData) {
    const panels = findAll(initialData, "engagementPanelSectionListRenderer").filter(
      (p) => p?.panelIdentifier === "engagement-panel-macro-markers-description-chapters" ||
        p?.targetId === "engagement-panel-macro-markers-description-chapters"
    );
    for (const panel of panels) {
      const items = findAll(panel, "macroMarkersListItemRenderer");
      if (!items.length) continue;
      return items.map((item) => {
        const seconds = item.onTap?.watchEndpoint?.startTimeSeconds;
        return {
          title: cleanText(readText(item.title)),
          startMs: seconds != null ? toInt(seconds * 1000) : parseTimestamp(readText(item.timeDescription)),
        };
      });
    }
    return [];
  }

  // Sections from the creator's chapters; empty when the Video has none.
  function extractSections(initialData, playerResponse) {
    const lengthSeconds = toInt(playerResponse?.videoDetails?.lengthSeconds);
    const durationMs = lengthSeconds ? lengthSeconds * 1000 : null;
    let chapters = chaptersFromMarkers(initialData);
    if (!chapters.length) chapters = chaptersFromEngagementPanel(initialData);
    return buildSections(chapters, durationMs);
  }

  const api = {
    UNSUPPORTED,
    findAll,
    readText,
    extractJsonObjectAfter,
    parseWatchPageHtml,
    unsupported,
    detectUnsupported,
    isSettled,
    getCaptionTracks,
    selectCaptionTrack,
    describeTrack,
    normalizeJson3Transcript,
    normalizeTranscriptPanel,
    getTranscriptPanelParams,
    parseTimestamp,
    buildSections,
    extractSections,
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.CueYouTubeData ??= Object.freeze(api);
})();
