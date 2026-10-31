/**
 * Durable idempotency ledger: which handoff ids this machine has already
 * accepted. A retry from the sender (or an HTTP client that timed out and tried
 * again) must not wake the agent twice for the same handoff.
 *
 * JSON on disk, rewritten atomically, oldest ids pruned past `limit`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const FILE_VERSION = 1;

export interface LedgerOptions {
	/** Absolute path. Omit for an in-memory ledger (tests). */
	file?: string;
	/** How many ids to remember. */
	limit?: number;
}

interface LedgerFile {
	v: typeof FILE_VERSION;
	ids: string[];
}

export class Ledger {
	readonly #file?: string;
	readonly #limit: number;
	readonly #ids: string[] = [];
	readonly #seen = new Set<string>();
	#pending?: Promise<void>;

	constructor(options: LedgerOptions = {}) {
		this.#file = options.file;
		this.#limit = options.limit ?? 2_000;
		if (!this.#file) return;
		try {
			const parsed = JSON.parse(fs.readFileSync(this.#file, "utf-8")) as Partial<LedgerFile>;
			if (Array.isArray(parsed.ids)) {
				for (const id of parsed.ids) {
					if (typeof id !== "string" || this.#seen.has(id)) continue;
					this.#ids.push(id);
					this.#seen.add(id);
				}
			}
		} catch {
			// Missing or corrupt ledger: start empty. Losing idempotency history is
			// strictly better than refusing to start.
		}
	}

	/** Whether this id was already accepted. */
	has(id: string): boolean {
		return this.#seen.has(id);
	}

	get size(): number {
		return this.#ids.length;
	}

	/** Record an id. Returns false when it was already present. */
	add(id: string): boolean {
		if (this.#seen.has(id)) return false;
		this.#seen.add(id);
		this.#ids.push(id);
		while (this.#ids.length > this.#limit) {
			const evicted = this.#ids.shift();
			if (evicted !== undefined) this.#seen.delete(evicted);
		}
		this.#schedule();
		return true;
	}

	/** Wait for any queued write to land. Call on shutdown. */
	async flush(): Promise<void> {
		await this.#pending;
	}

	#schedule(): void {
		const file = this.#file;
		if (!file) return;
		const write = async (): Promise<void> => {
			const payload: LedgerFile = { v: FILE_VERSION, ids: [...this.#ids] };
			await fs.promises.mkdir(path.dirname(file), { recursive: true });
			const temp = `${file}.${process.pid}.tmp`;
			await fs.promises.writeFile(temp, `${JSON.stringify(payload)}\n`, "utf-8");
			await fs.promises.rename(temp, file);
		};
		// Chain writes so two quick handoffs cannot interleave into a torn file.
		this.#pending = (this.#pending ?? Promise.resolve()).then(write, write);
	}
}
