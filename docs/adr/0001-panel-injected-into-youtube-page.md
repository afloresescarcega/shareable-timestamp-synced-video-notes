# Cue panel is injected into YouTube's right-hand column

We render the Cue panel inside the YouTube watch page, in the right-hand column where recommendations normally sit, rather than in Chrome's side panel or a separate window. It sits beside the video without shrinking it and feels native. In exchange it depends on YouTube's page structure, which changes without notice, and there's nowhere to put it in theater or fullscreen mode, so the panel is hidden there.

## Considered Options

- **Separate browser window**: movable to a second monitor, but awkward on a single laptop screen.
- **Chrome side panel**: stable browser API, but it narrows the whole page and feels detached from the video.
