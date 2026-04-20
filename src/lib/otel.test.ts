import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@opentelemetry/api", () => ({
	trace: { disable: vi.fn() },
	metrics: { disable: vi.fn() },
	diag: { setLogger: vi.fn() },
	DiagLogLevel: { NONE: 0 },
}));

const mockConfig = vi.hoisted(() => ({ otelDisabled: false }));
vi.mock("./config.js", () => ({
	config: mockConfig,
}));

import { trace, metrics, diag } from "@opentelemetry/api";
import { disableOtelIfRequested } from "./otel.js";

describe("disableOtelIfRequested", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockConfig.otelDisabled = false;
	});

	it("disables OTel when otelDisabled is true", () => {
		mockConfig.otelDisabled = true;
		disableOtelIfRequested();

		expect(trace.disable).toHaveBeenCalled();
		expect(metrics.disable).toHaveBeenCalled();
		expect(diag.setLogger).toHaveBeenCalled();
	});

	it("does not disable OTel when otelDisabled is false", () => {
		mockConfig.otelDisabled = false;
		disableOtelIfRequested();

		expect(trace.disable).not.toHaveBeenCalled();
		expect(metrics.disable).not.toHaveBeenCalled();
		expect(diag.setLogger).not.toHaveBeenCalled();
	});
});
