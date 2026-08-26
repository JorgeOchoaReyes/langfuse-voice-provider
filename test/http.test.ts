import test from "node:test";
import assert from "node:assert/strict";
import { HttpClient } from "../src/core/http.js";
import { ApiError, NotFoundError } from "../src/core/errors.js";

const noSleep = async () => {};

function stubFetch(responses: Array<() => Response | Promise<Response>>) {
  let call = 0;
  const calls: string[] = [];
  const impl = (async (input: any) => {
    calls.push(String(input));
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return next!();
  }) as typeof fetch;
  return { impl, calls: () => calls, count: () => call };
}

test("a 500 is retried and then succeeds", async () => {
  const stub = stubFetch([
    () => new Response("boom", { status: 500 }),
    () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ]);
  const client = new HttpClient({
    baseUrl: "https://example.test",
    fetchImpl: stub.impl,
    sleepImpl: noSleep,
  });

  const result = await client.request<{ ok: boolean }>({ path: "/thing" });

  assert.deepEqual(result, { ok: true });
  assert.equal(stub.count(), 2);
});

test("a 400 fails immediately without retrying", async () => {
  const stub = stubFetch([() => new Response("bad prompt", { status: 400 })]);
  const client = new HttpClient({
    baseUrl: "https://example.test",
    fetchImpl: stub.impl,
    sleepImpl: noSleep,
  });

  await assert.rejects(
    () => client.request({ path: "/thing" }),
    (error: unknown) => error instanceof ApiError && error.status === 400,
  );
  assert.equal(stub.count(), 1);
});

test("retries are bounded by maxRetries", async () => {
  const stub = stubFetch([() => new Response("nope", { status: 503 })]);
  const client = new HttpClient({
    baseUrl: "https://example.test",
    fetchImpl: stub.impl,
    sleepImpl: noSleep,
    maxRetries: 2,
  });

  await assert.rejects(() => client.request({ path: "/thing" }), ApiError);
  assert.equal(stub.count(), 3);
});

test("allow404 turns a 404 into null instead of an error", async () => {
  const stub = stubFetch([() => new Response("missing", { status: 404 })]);
  const client = new HttpClient({
    baseUrl: "https://example.test",
    fetchImpl: stub.impl,
    sleepImpl: noSleep,
  });

  assert.equal(await client.request({ path: "/thing", allow404: true }), null);
});

test("a 404 without allow404 raises NotFoundError", async () => {
  const stub = stubFetch([() => new Response("missing", { status: 404 })]);
  const client = new HttpClient({
    baseUrl: "https://example.test",
    fetchImpl: stub.impl,
    sleepImpl: noSleep,
  });

  await assert.rejects(() => client.request({ path: "/thing" }), NotFoundError);
});

test("transport failures are retried, then reported", async () => {
  let attempts = 0;
  const impl = (async () => {
    attempts += 1;
    throw new Error("ECONNRESET");
  }) as unknown as typeof fetch;
  const client = new HttpClient({
    baseUrl: "https://example.test",
    fetchImpl: impl,
    sleepImpl: noSleep,
    maxRetries: 2,
  });

  await assert.rejects(
    () => client.request({ path: "/thing" }),
    (error: unknown) =>
      error instanceof ApiError && /ECONNRESET/.test(error.message),
  );
  assert.equal(attempts, 3);
});

test("empty and null query values are omitted from the URL", async () => {
  const stub = stubFetch([() => new Response("{}", { status: 200 })]);
  const client = new HttpClient({
    baseUrl: "https://example.test",
    fetchImpl: stub.impl,
    sleepImpl: noSleep,
  });

  await client.request({
    path: "/thing",
    query: { keep: "yes", drop: undefined, alsoDrop: "", nope: null },
  });

  const url = new URL(stub.calls()[0] as string);
  assert.equal(url.searchParams.get("keep"), "yes");
  assert.equal(url.searchParams.has("drop"), false);
  assert.equal(url.searchParams.has("alsoDrop"), false);
  assert.equal(url.searchParams.has("nope"), false);
});

test("a 204 yields null rather than a JSON parse error", async () => {
  const stub = stubFetch([() => new Response(null, { status: 204 })]);
  const client = new HttpClient({
    baseUrl: "https://example.test",
    fetchImpl: stub.impl,
    sleepImpl: noSleep,
  });

  assert.equal(await client.request({ path: "/thing" }), null);
});

test("bearer tokens in an error body are masked before they reach the message", async () => {
  const stub = stubFetch([
    () =>
      new Response("rejected token Bearer abcdef1234567890", { status: 400 }),
  ]);
  const client = new HttpClient({
    baseUrl: "https://example.test",
    fetchImpl: stub.impl,
    sleepImpl: noSleep,
  });

  await assert.rejects(
    () => client.request({ path: "/thing" }),
    (error: unknown) =>
      error instanceof ApiError &&
      !error.message.includes("abcdef1234567890") &&
      /Bearer \*\*\*/.test(error.message),
  );
});
