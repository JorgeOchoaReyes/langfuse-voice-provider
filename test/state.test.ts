import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileStateStore, MemoryStateStore, createStateStore } from "../src/sync/state.js";
import type { BindingState } from "../src/sync/state.js";

const SAMPLE: BindingState = {
  langfuseHash: "aaa",
  providerHash: "bbb",
  langfuseVersion: 3,
  lastSyncAt: "2026-01-01T00:00:00.000Z",
  lastDirection: "push",
};

async function tempFile(name = "state.json"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "lfv-state-"));
  return path.join(dir, name);
}

test("memory store round-trips and deletes", async () => {
  const store = new MemoryStateStore();
  assert.equal(await store.get("a"), undefined);
  await store.set("a", SAMPLE);
  assert.deepEqual(await store.get("a"), SAMPLE);
  await store.delete("a");
  assert.equal(await store.get("a"), undefined);
});

test("file store persists across instances", async () => {
  const file = await tempFile();
  const first = new FileStateStore(file);
  await first.set("binding-1", SAMPLE);

  const second = new FileStateStore(file);
  assert.deepEqual(await second.get("binding-1"), SAMPLE);
});

test("file store creates missing parent directories", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lfv-state-"));
  const file = path.join(dir, "nested", "deeper", "state.json");
  const store = new FileStateStore(file);
  await store.set("a", SAMPLE);
  assert.deepEqual(await new FileStateStore(file).get("a"), SAMPLE);
});

test("a corrupt state file is treated as empty rather than fatal", async () => {
  const file = await tempFile();
  await writeFile(file, "{ not json", "utf8");
  const store = new FileStateStore(file);
  assert.equal(await store.get("a"), undefined);
  await store.set("a", SAMPLE);
  assert.deepEqual(await store.get("a"), SAMPLE);
});

test("concurrent writes all survive", async () => {
  const file = await tempFile();
  const store = new FileStateStore(file);
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.set(`binding-${index}`, { ...SAMPLE, langfuseVersion: index }),
    ),
  );
  const written = JSON.parse(await readFile(file, "utf8")) as {
    bindings: Record<string, BindingState>;
  };
  assert.equal(Object.keys(written.bindings).length, 20);
  assert.equal(written.bindings["binding-7"]?.langfuseVersion, 7);
});

test("createStateStore honours the driver", async () => {
  assert.ok(createStateStore({ driver: "memory", path: "x" }) instanceof MemoryStateStore);
  assert.ok(createStateStore({ driver: "file", path: "x" }) instanceof FileStateStore);
});
