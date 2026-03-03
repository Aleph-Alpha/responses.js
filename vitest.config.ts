import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		exclude: ["tests/**"],
		coverage: {
			provider: "v8",
			exclude: ["src/**/*.test.ts", "src/**/__test_helpers__/**"],
			thresholds: {
				statements: 80,
				branches: 70,
				functions: 80,
				lines: 80,
			},
		},
	},
});
