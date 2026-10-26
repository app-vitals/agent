/**
 * runtime/agent-features-ref.unit.test.ts
 * Tests an independent instance; the process-wide singleton is not mutated.
 */

import { describe, expect, it } from "bun:test";
import { createAgentFeaturesRef } from "./agent-features-ref.ts";

describe("createAgentFeaturesRef", () => {
  it("is undefined until set, then reflects the latest features", () => {
    const ref = createAgentFeaturesRef();
    expect(ref.get()).toBeUndefined();
    ref.set({ transcriptUpload: true, repoAccessCheck: false });
    expect(ref.get()).toEqual({
      transcriptUpload: true,
      repoAccessCheck: false,
    });
    ref.set(undefined);
    expect(ref.get()).toBeUndefined();
  });
});
