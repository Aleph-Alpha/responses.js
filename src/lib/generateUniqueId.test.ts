import { describe, it, expect } from "vitest";
import { generateUniqueId } from "./generateUniqueId.js";

describe("generateUniqueId", () => {
	it("returns a hex string without prefix", () => {
		const id = generateUniqueId();
		expect(id).toMatch(/^[0-9a-f]{48}$/);
	});

	it("returns a prefixed hex string", () => {
		const id = generateUniqueId("resp");
		expect(id).toMatch(/^resp_[0-9a-f]{48}$/);
	});

	it("generates unique IDs", () => {
		const ids = new Set(Array.from({ length: 100 }, () => generateUniqueId()));
		expect(ids.size).toBe(100);
	});

	it("supports various prefixes", () => {
		expect(generateUniqueId("msg")).toMatch(/^msg_/);
		expect(generateUniqueId("fc")).toMatch(/^fc_/);
		expect(generateUniqueId("mcp")).toMatch(/^mcp_/);
	});
});
