import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ledger } from "../src/store";

function tempFile(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bus-ledger-"));
	return path.join(dir, "nested", "ledger.json");
}

describe("ledger", () => {
	test("remembers an id exactly once in-process", () => {
		const ledger = new Ledger();
		expect(ledger.has("a")).toBe(false);
		expect(ledger.add("a")).toBe(true);
		expect(ledger.add("a")).toBe(false);
		expect(ledger.has("a")).toBe(true);
		expect(ledger.size).toBe(1);
	});

	test("survives a restart through its file", async () => {
		const file = tempFile();
		const first = new Ledger({ file });
		first.add("id-1");
		await first.flush();

		const second = new Ledger({ file });
		expect(second.has("id-1")).toBe(true);
		expect(second.add("id-1")).toBe(false);
	});

	test("prunes oldest ids past the limit", () => {
		const ledger = new Ledger({ limit: 2 });
		ledger.add("one");
		ledger.add("two");
		ledger.add("three");
		expect(ledger.size).toBe(2);
		expect(ledger.has("one")).toBe(false);
		expect(ledger.has("three")).toBe(true);
	});

	test("ignores a corrupt ledger instead of refusing to start", () => {
		const file = tempFile();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "{not json", "utf-8");
		const ledger = new Ledger({ file });
		expect(ledger.size).toBe(0);
		expect(ledger.add("fresh")).toBe(true);
	});

	test("keeps concurrent writes from tearing the file", async () => {
		const file = tempFile();
		const ledger = new Ledger({ file });
		for (let i = 0; i < 25; i += 1) ledger.add(`id-${i}`);
		await ledger.flush();
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { ids: string[] };
		expect(parsed.ids).toHaveLength(25);
		expect(parsed.ids.at(-1)).toBe("id-24");
	});
});
