import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalize,
  documentsEqual,
  hashDocument,
  normalizeText,
} from "../src/core/hash.js";

test("canonicalize sorts object keys so key order cannot change the hash", () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: 2 }));
});

test("canonicalize is stable for nested structures and arrays", () => {
  const left = { outer: { z: [1, { b: 2, a: 1 }], a: "x" } };
  const right = { outer: { a: "x", z: [1, { a: 1, b: 2 }] } };
  assert.equal(canonicalize(left), canonicalize(right));
});

test("array order is significant, unlike key order", () => {
  assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
});

test("normalizeText folds CRLF, trailing spaces and surrounding blank lines", () => {
  assert.equal(normalizeText("hello\r\nworld  \n"), "hello\nworld");
  assert.equal(normalizeText("  spaced  "), "spaced");
});

test("cosmetic whitespace differences do not count as a prompt change", () => {
  const a = { text: "Be helpful.\r\nBe brief.  ", fields: {} };
  const b = { text: "Be helpful.\nBe brief.", fields: {} };
  assert.ok(documentsEqual(a, b));
});

test("an absent field and an empty field hash identically", () => {
  const withEmpty = { text: "hi", fields: { firstMessage: "" } };
  const without = { text: "hi", fields: {} };
  assert.equal(hashDocument(withEmpty), hashDocument(without));
});

test("a real field change moves the hash", () => {
  const before = { text: "hi", fields: { firstMessage: "Hello" } };
  const after = { text: "hi", fields: { firstMessage: "Hi there" } };
  assert.notEqual(hashDocument(before), hashDocument(after));
});

test("a text change moves the hash", () => {
  assert.notEqual(
    hashDocument({ text: "a", fields: {} }),
    hashDocument({ text: "b", fields: {} }),
  );
});
