import test from "node:test";
import assert from "node:assert/strict";
import { renderDocument, renderText } from "../src/sync/render.js";

test("with no variables the document is returned untouched", () => {
  const document = { text: "Hello {{name}}", fields: { firstMessage: "{{greeting}}" } };
  assert.equal(renderDocument(document, {}), document);
});

test("only configured variables are substituted", () => {
  const rendered = renderText("Hi {{name}}, your id is {{caller_id}}", {
    name: "Ada",
  });
  assert.equal(rendered, "Hi Ada, your id is {{caller_id}}");
});

test("whitespace inside the braces is tolerated", () => {
  assert.equal(renderText("{{ name }}", { name: "Ada" }), "Ada");
});

test("fields are rendered alongside the main text", () => {
  const rendered = renderDocument(
    { text: "{{a}}", fields: { firstMessage: "{{a}} and {{b}}" } },
    { a: "1", b: "2" },
  );
  assert.equal(rendered.text, "1");
  assert.equal(rendered.fields["firstMessage"], "1 and 2");
});

test("a variable explicitly set to empty string renders as empty, not skipped", () => {
  assert.equal(renderText("[{{x}}]", { x: "" }), "[]");
});
