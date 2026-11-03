// Fetches the source material for a Video: its Transcript and its Sections
// from creator chapters. Only same-origin youtube.com requests that YouTube's
// own watch page makes; no extra permissions, keys, or backend.
//
//   CueSourceMaterial.load(videoId) -> Promise<SourceMaterial>
//
// SourceMaterial is one of:
//   { status: "ready", videoId, title, durationMs, transcript, sections }
//     transcript: { languageCode, kind: "manual" | "auto-generated", entries: [{ startMs, durationMs, text }] }
//     sections:   [{ title, startMs, endMs, origin: "creator" }]  (empty when the Video has no chapters)
//   { status: "unsupported", videoId, reason, message }   (Prepare can't run)
//   { status: "error", videoId, message }                 (transient failure; retry is reasonable)
//
// Only settled results are cached (CueYouTubeData.isSettled): a Transcript
// that was read, or a Video YouTube says has none. A page that couldn't be
// read, a Video not playable right now, a live stream, or a failure is
// fetched again on the next load(), so a passing problem never sticks.
//
// The promise rejects with an AbortError when superseded by a load for another
// Video or by cancel(); callers should ignore that rejection.
//
// fetch and the page origin are passed to createSourceMaterialLoader, so this
// loads under Node for tests; the extension uses the CueSourceMaterial instance.
(() => {
  "use strict";

  const isNode = typeof module === "object" && module.exports;
  if (!isNode && globalThis.CueSourceMaterial) return;
  const data = isNode ? require("./youtube-data.js") : globalThis.CueYouTubeData;

  const CACHE_LIMIT = 10;

  function createSourceMaterialLoader({ fetchImpl, origin, cacheLimit = CACHE_LIMIT }) {
    const cache = new Map(); // videoId -> Promise<SourceMaterial> (in flight or settled)
    let active = null; // { videoId, controller } for the request currently in flight

    async function fetchOk(url, options) {
      const response = await fetchImpl(url, { credentials: "same-origin", ...options });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${new URL(url).pathname}`);
      return response;
    }

    // Timed text for a caption track. Returns [] when YouTube answers with no
    // body, which it sometimes does for direct requests.
    async function fetchCaptionTrack(track, signal) {
      const url = new URL(track.baseUrl, origin);
      url.searchParams.set("fmt", "json3");
      const body = await (await fetchOk(url.href, { signal })).text();
      if (!body.trim()) return [];
      return data.normalizeJson3Transcript(JSON.parse(body));
    }

    // The same request YouTube's "Show transcript" panel makes.
    async function fetchTranscriptPanel(params, innertube, signal) {
      if (!params || !innertube.context) return [];
      const url = new URL("/youtubei/v1/get_transcript", origin);
      url.searchParams.set("prettyPrint", "false");
      if (innertube.apiKey) url.searchParams.set("key", innertube.apiKey);
      const response = await fetchOk(url.href, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context: innertube.context, params }),
        signal,
      });
      return data.normalizeTranscriptPanel(await response.json());
    }

    async function fetchSourceMaterial(videoId, signal) {
      // Fetch the watch page fresh rather than reading the live page: after
      // in-app navigation the page's initial data still describes the first Video.
      const pageUrl = new URL("/watch", origin);
      pageUrl.searchParams.set("v", videoId);
      const html = await (await fetchOk(pageUrl.href, { signal })).text();
      const page = data.parseWatchPageHtml(html);
      // A consent or bot-check page, or markup Cue can't parse: not proof
      // that the Video is unavailable or has no Transcript.
      if (!page.playerResponse) throw new Error("YouTube's watch page couldn't be read");

      const reason = data.detectUnsupported(page.playerResponse);
      if (reason) return data.unsupported(videoId, reason);
      const details = page.playerResponse.videoDetails ?? {};
      if (details.videoId && details.videoId !== videoId) {
        throw new Error("YouTube returned data for a different Video");
      }

      const sections = data.extractSections(page.initialData, page.playerResponse);
      const track = data.selectCaptionTrack(data.getCaptionTracks(page.playerResponse));
      const panelParams = data.getTranscriptPanelParams(page.initialData);
      if (!track && !panelParams) return data.unsupported(videoId, data.UNSUPPORTED.NO_TRANSCRIPT);

      const failures = [];
      let entries = [];
      if (track) {
        try {
          entries = await fetchCaptionTrack(track, signal);
        } catch (error) {
          if (error.name === "AbortError") throw error;
          failures.push(error);
        }
      }
      if (!entries.length && panelParams) {
        try {
          entries = await fetchTranscriptPanel(panelParams, page.innertube, signal);
        } catch (error) {
          if (error.name === "AbortError") throw error;
          failures.push(error);
        }
      }
      if (!entries.length) {
        // A Transcript is advertised but couldn't be read: a transient failure,
        // not proof that the Video has no Transcript.
        throw failures[0] ?? new Error("YouTube returned an empty Transcript");
      }

      const lengthSeconds = Number(details.lengthSeconds);
      return {
        status: "ready",
        videoId,
        title: details.title ?? null,
        durationMs: Number.isFinite(lengthSeconds) && lengthSeconds > 0 ? lengthSeconds * 1000 : null,
        transcript: { ...data.describeTrack(track), entries },
        sections,
      };
    }

    function cancel() {
      if (!active) return;
      active.controller.abort();
      cache.delete(active.videoId); // an aborted promise must not be reused
      active = null;
    }

    function remember(videoId, promise) {
      cache.delete(videoId); // re-insert so Map order tracks recency
      cache.set(videoId, promise);
      while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
    }

    function load(videoId) {
      // Only the Video being watched is worth fetching.
      if (active && active.videoId !== videoId) cancel();
      const cached = cache.get(videoId);
      if (cached) {
        remember(videoId, cached);
        return cached;
      }

      const controller = new AbortController();
      const request = { videoId, controller };
      active = request;

      const promise = fetchSourceMaterial(videoId, controller.signal)
        .catch((error) => {
          if (error.name === "AbortError") throw error;
          return { status: "error", videoId, message: `Couldn't read the Transcript: ${error.message}` };
        })
        .then((result) => {
          // Keep only settled results; a later load retries anything else.
          if (!data.isSettled(result) && cache.get(videoId) === promise) cache.delete(videoId);
          return result;
        })
        .finally(() => {
          if (active === request) active = null;
        });
      remember(videoId, promise);
      return promise;
    }

    return { load, cancel };
  }

  if (isNode) {
    module.exports = { createSourceMaterialLoader };
  } else {
    globalThis.CueSourceMaterial = Object.freeze(
      createSourceMaterialLoader({ fetchImpl: (...args) => fetch(...args), origin: location.origin })
    );
  }
})();
