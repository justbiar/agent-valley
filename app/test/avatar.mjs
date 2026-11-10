// The agent's look: the server keeps only small integers in range, and its ranges match the lists the pages draw from.
// Run: node test/avatar.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { parseAvatar, AVATAR_SIZES } from "../src/avatar.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok  ", name); };

test("a valid look is kept as it is", () => {
  const look = { skin: 2, hair: 3, hairColor: 7, top: 0, bottom: 1, extra: 4, build: 2 };
  assert.deepEqual(parseAvatar(look), look);
});
test("no look means the page picks one from the company id", () => {
  assert.equal(parseAvatar(undefined), null);
  assert.equal(parseAvatar("blue"), null);
});
test("out of range, fractional or text values are refused", () => {
  assert.throws(() => parseAvatar({ ...base(), skin: 6 }), /skin/);
  assert.throws(() => parseAvatar({ ...base(), top: 1.5 }), /top/);
  assert.throws(() => parseAvatar({ ...base(), extra: "<script>" }), /extra/);
  assert.throws(() => parseAvatar({ skin: 1 }), /hair/);
});
test("unknown fields are dropped", () => {
  assert.deepEqual(Object.keys(parseAvatar({ ...base(), html: "<b>x</b>" })).sort(), Object.keys(AVATAR_SIZES).sort());
});
test("the server's ranges match the lists in assets/avatar.js", () => {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(here, "..", "..", "assets", "avatar.js"), "utf8"), ctx);
  const lists = ctx.window.AVAvatar.LISTS;
  for (const [k, n] of Object.entries(AVATAR_SIZES)) assert.equal(lists[k].length, n, k);
  assert.deepEqual(Object.keys(lists).sort(), Object.keys(AVATAR_SIZES).sort());
});
function base() { return { skin: 0, hair: 0, hairColor: 0, top: 0, bottom: 0, extra: 0, build: 0 }; }
console.log(`\n${passed}/${passed} passed`);
