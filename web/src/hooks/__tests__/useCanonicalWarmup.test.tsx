import { renderHook, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import { useCanonicalWarmup } from "../useCanonicalWarmup";
import { api } from "../../services/api";

describe("useCanonicalWarmup", () => {
  const warmupSpy = vi.spyOn(api, "warmupCanonicalCache");

  beforeEach(() => {
    warmupSpy.mockReset();
  });

  it("invokes warmup once when cache is missing", async () => {
    warmupSpy.mockResolvedValue({ state: "warming" });

    const { rerender } = renderHook((props) => useCanonicalWarmup(props), {
      initialProps: {
        token: "token",
        projectId: "project-1",
        jobId: "job-1",
        cacheState: "missing" as const,
      },
    });

    await waitFor(() => {
      expect(warmupSpy).toHaveBeenCalledTimes(1);
    });

    rerender({ token: "token", projectId: "project-1", jobId: "job-1", cacheState: "missing" as const });

    await waitFor(() => {
      expect(warmupSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("does not call warmup when cache is ready", async () => {
    renderHook(() =>
      useCanonicalWarmup({
        token: "token",
        projectId: "project-1",
        jobId: "job-1",
        cacheState: "ready",
      }),
    );

    await waitFor(() => {
      expect(warmupSpy).not.toHaveBeenCalled();
    });
  });
});
