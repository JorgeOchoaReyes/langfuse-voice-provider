import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * What the engine remembers about a binding after a successful sync.
 *
 * Storing both sides' hashes is what makes three-way sync possible: without
 * them a difference between Langfuse and a provider is ambiguous, because
 * there is no way to tell which side moved.
 */
export interface BindingState {
  /** Hash of the document as last seen in Langfuse. */
  langfuseHash: string;
  /** Hash of the document as last seen on the provider. */
  providerHash: string;
  /** Langfuse version the binding last agreed on. */
  langfuseVersion: number;
  lastSyncAt: string;
  lastDirection: "push" | "pull" | "none";
}

export interface StateStore {
  get(bindingId: string): Promise<BindingState | undefined>;
  set(bindingId: string, state: BindingState): Promise<void>;
  delete(bindingId: string): Promise<void>;
  all(): Promise<Record<string, BindingState>>;
}

/** Non-persistent store. Bidirectional sync degrades to the conflict policy. */
export class MemoryStateStore implements StateStore {
  private readonly entries = new Map<string, BindingState>();

  async get(bindingId: string): Promise<BindingState | undefined> {
    return this.entries.get(bindingId);
  }

  async set(bindingId: string, state: BindingState): Promise<void> {
    this.entries.set(bindingId, state);
  }

  async delete(bindingId: string): Promise<void> {
    this.entries.delete(bindingId);
  }

  async all(): Promise<Record<string, BindingState>> {
    return Object.fromEntries(this.entries);
  }
}

interface StateFile {
  version: 1;
  bindings: Record<string, BindingState>;
}

/**
 * JSON-file store.
 *
 * Writes go to a temp file and are renamed into place, so a crash mid-write
 * cannot leave a truncated state file that would make the next run treat every
 * binding as brand new.
 */
export class FileStateStore implements StateStore {
  private cache: StateFile | undefined;
  private loading: Promise<StateFile> | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async get(bindingId: string): Promise<BindingState | undefined> {
    const file = await this.load();
    return file.bindings[bindingId];
  }

  async set(bindingId: string, state: BindingState): Promise<void> {
    const file = await this.load();
    file.bindings[bindingId] = state;
    await this.persist();
  }

  async delete(bindingId: string): Promise<void> {
    const file = await this.load();
    delete file.bindings[bindingId];
    await this.persist();
  }

  async all(): Promise<Record<string, BindingState>> {
    return { ...(await this.load()).bindings };
  }

  /**
   * Memoised on the in-flight promise, not just on the result: concurrent
   * callers must share one load, or each would install its own fresh cache
   * object and every write but the last would be lost.
   */
  private load(): Promise<StateFile> {
    if (this.cache) return Promise.resolve(this.cache);
    if (!this.loading) {
      this.loading = (async () => {
        let file: StateFile;
        try {
          const text = await readFile(this.filePath, "utf8");
          const parsed = JSON.parse(text) as Partial<StateFile>;
          file = {
            version: 1,
            bindings:
              parsed && typeof parsed.bindings === "object" && parsed.bindings
                ? parsed.bindings
                : {},
          };
        } catch {
          // Missing or unreadable: start clean rather than refusing to run.
          // The cost is one conflict-policy decision per binding, not data loss.
          file = { version: 1, bindings: {} };
        }
        this.cache = file;
        return file;
      })();
    }
    return this.loading;
  }

  /** Serialise writes so concurrent binding updates cannot interleave. */
  private persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const file = this.cache ?? { version: 1 as const, bindings: {} };
      await mkdir(path.dirname(path.resolve(this.filePath)), { recursive: true });
      const tempPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(tempPath, JSON.stringify(file, null, 2) + "\n", "utf8");
      await rename(tempPath, this.filePath);
    });
    return this.writeChain;
  }
}

export function createStateStore(options: {
  driver: "file" | "memory";
  path: string;
}): StateStore {
  return options.driver === "memory"
    ? new MemoryStateStore()
    : new FileStateStore(options.path);
}
