import test from "node:test";
import assert from "node:assert/strict";
import { maskSecret, redactObject, redactText } from "../src/core/redact.js";

test("maskSecret keeps a debuggable fingerprint and hides the rest", () => {
  assert.equal(maskSecret("sk-abcdefghijklmnop"), "sk-a***op");
  assert.equal(maskSecret("short"), "***");
  assert.equal(maskSecret(undefined), "<unset>");
});

test("credential-looking keys are masked at any depth", () => {
  const redacted = redactObject({
    langfuse: { publicKey: "pk-1234567890", secretKey: "sk-1234567890" },
    providers: { retell: { apiKey: "key-1234567890", baseUrl: "https://api" } },
    bindings: [{ agentId: "agent_1", token: "tok-1234567890" }],
  }) as any;

  assert.equal(redacted.langfuse.secretKey, "sk-1***90");
  assert.equal(redacted.providers.retell.apiKey, "key-***90");
  assert.equal(redacted.providers.retell.baseUrl, "https://api");
  assert.equal(redacted.bindings[0].agentId, "agent_1");
  assert.equal(redacted.bindings[0].token, "tok-***90");
});

test("redactText masks bearer tokens and provider key prefixes", () => {
  assert.equal(
    redactText("Authorization: Bearer abcdefghij123"),
    "Authorization: Bearer ***",
  );
  assert.match(redactText("used sk-abcdefgh12345 today"), /sk_\*\*\*/);
});
