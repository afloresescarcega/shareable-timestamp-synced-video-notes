// Run with: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const { isUserAction, userOnly } = require("../src/user-action.js");

test("only events the browser marks trusted count as the user's", () => {
  assert.equal(isUserAction({ isTrusted: true }), true);
  for (const event of [{ isTrusted: false }, {}, null, undefined]) assert.equal(isUserAction(event), false);
});

test("userOnly runs the handler for a real click and ignores a scripted one", () => {
  const seen = [];
  const handler = userOnly(function (event) {
    seen.push([this, event.type]);
    return "ran";
  });
  const target = {};
  assert.equal(handler.call(target, { type: "click", isTrusted: false }), undefined);
  assert.equal(handler.call(target, { type: "click", isTrusted: true }), "ran");
  assert.deepEqual(seen, [[target, "click"]]);
});
