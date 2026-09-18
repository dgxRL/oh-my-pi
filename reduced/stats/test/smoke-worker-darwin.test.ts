import { afterEach, describe, expect, it, vi } from "bun:test";
import { smokeTestSyncWorker } from "../src/aggregator";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-smoke-darwin-");

afterEach(() => {
	vi.restoreAllMocks();
});

describe("smokeTestSyncWorker", () => {
	it("skips the worker spawn on darwin so omp --smoke-test stays off the macOS abort surface", async () => {
		// Reduced copy: bun-types here lacks the accessor-spy overload.
		const spyOnAccessor = vi.spyOn as unknown as (
			target: object,
			key: string,
			accessor: "get",
		) => { mockReturnValue(value: string): unknown };
		spyOnAccessor(process, "platform", "get").mockReturnValue("darwin");
		const workerSpy = vi.spyOn(globalThis, "Worker") as unknown as {
			mockImplementation(impl: () => never): unknown;
		};
		workerSpy.mockImplementation(() => {
			throw new Error("worker should not be created on darwin");
		});

		await expect(smokeTestSyncWorker()).resolves.toBeUndefined();
		expect(workerSpy).not.toHaveBeenCalled();
	});
});
