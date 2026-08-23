import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

describe("OMP Official Extension Loader Subsystem", () => {
  it("loads and initializes omp-path-rules through the official OMP Extension Loader", async () => {
    const extensionEntry = path.resolve("src/index.ts");
    const result = await loadExtensions([extensionEntry], process.cwd());

    // 1. Assert zero loader errors (no syntax, compilation, or runtime init errors)
    expect(result.errors).toEqual([]);

    // 2. Assert extension definition was successfully returned
    expect(result.extensions.length).toBe(1);

    const loaded = result.extensions[0];
    expect(loaded.resolvedPath).toBe(extensionEntry);
    expect(loaded.label).toBe("omp-path-rules");
  });
});
