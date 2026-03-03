import { describe, it, expect } from "vitest";
import { logger, httpLogger } from "./logger.js";

describe("logger", () => {
	it("exports a pino logger instance", () => {
		expect(logger).toBeDefined();
		expect(typeof logger.info).toBe("function");
		expect(typeof logger.error).toBe("function");
		expect(typeof logger.debug).toBe("function");
		expect(typeof logger.warn).toBe("function");
	});

	it("defaults to info level", () => {
		expect(logger.level).toBe("info");
	});
});

describe("httpLogger", () => {
	it("exports a pino-http middleware function", () => {
		expect(httpLogger).toBeDefined();
		expect(typeof httpLogger).toBe("function");
	});
});
