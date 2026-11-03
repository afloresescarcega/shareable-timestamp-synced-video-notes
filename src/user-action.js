// Only a real user's click or key press may start something that costs money
// or is hard to undo (Prepare, confirming a cost, export/import, replacing or
// deleting Notes, merging or splitting Entities).
//
// Cue's panel lives in YouTube's page (ADR 0001), so YouTube's own scripts,
// and anything else running in the page, share its DOM: they can call
// element.click() or dispatch events on Cue's buttons. The browser marks
// those events isTrusted: false; a real click, tap, or Enter/Space on a
// focused button is isTrusted: true, as are clicks from assistive technology.
//
//   button.addEventListener("click", CueUserAction.userOnly(() => prepare.start()));
//
// Pure; loads under Node for tests.
(() => {
  "use strict";

  const isUserAction = (event) => event?.isTrusted === true;

  // Wraps an event handler so it ignores events the user didn't cause.
  function userOnly(handler) {
    return function onUserAction(event) {
      if (!isUserAction(event)) return undefined;
      return handler.call(this, event);
    };
  }

  const api = { isUserAction, userOnly };

  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.CueUserAction ??= Object.freeze(api);
})();
