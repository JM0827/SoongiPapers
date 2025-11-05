import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, beforeEach, it, expect, vi } from "vitest";

import { useProofreadAgent } from "../useProofreadAgent";
import { useWorkflowStore } from "../../store/workflow.store";
import { useProofreadCommandStore } from "../../store/proofreadCommand.store";
import { api } from "../../services/api";

vi.mock("../../services/api", () => {
  const requestProofreading = vi.fn();
  const fetchProofreadItems = vi.fn();
  const subscribeProofreadStream = vi.fn();
  const fetchProofreadSummary = vi.fn();
  return {
    api: {
      requestProofreading,
      fetchProofreadItems,
      subscribeProofreadStream,
      fetchProofreadSummary,
    },
  };
});

const zeroItemPage = {
  version: "v2" as const,
  run_id: "run-zero",
  chunk_id: "chunk-zero",
  tier: "quick",
  model: "model-zero",
  latency_ms: 0,
  prompt_tokens: 10,
  completion_tokens: 5,
  truncated: false,
  warnings: [] as string[],
  index_base: 0 as const,
  offset_semantics: "[start,end)" as const,
  stats: { item_count: 0 },
  metrics: {
    downshift_count: 0,
    forced_pagination: false,
    cursor_retry_count: 0,
  },
  items: [] as unknown[],
  has_more: false,
  next_cursor: null,
  provider_response_id: "resp-zero",
};

const pagedItem = {
  k: "style",
  s: "error" as const,
  r: "issue",
  t: "note" as const,
  i: [0, 0] as const,
  o: [0, 4] as const,
};

const makePage = (overrides: Partial<typeof zeroItemPage>) => ({
  ...zeroItemPage,
  ...overrides,
});

describe("useProofreadAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkflowStore.getState().resetProofreading(null);
    useProofreadCommandStore.getState().setStartProofread(null);
  });

  it("marks zero-item runs as done without additional fetches", async () => {
    const pushAssistant = vi.fn();

    (api.fetchProofreadItems as unknown as vi.Mock).mockResolvedValue({
      events: [],
      nextCursor: null,
      hasMore: false,
      total: 0,
    });
    (api.fetchProofreadSummary as unknown as vi.Mock).mockResolvedValue(null);
    (api.requestProofreading as unknown as vi.Mock).mockImplementation(
      async (
        _token: string,
        _projectId: string,
        _jobId: string,
        options?: { onEvent?: (event: Record<string, unknown>) => void },
      ) => {
        options?.onEvent?.({
          type: "stage",
          data: {
            proofreading_id: "proof-zero",
            run_id: "run-zero",
            tier: "quick",
            key: "summary",
            label: "Summary",
            status: "in_progress",
          },
        });
        options?.onEvent?.({
          type: "items",
          data: {
            project_id: "proj",
            run_id: "run-zero",
            proofreading_id: "proof-zero",
            tier: "quick",
            key: "summary",
            chunk_index: 0,
            page: makePage({}),
          },
        });
        options?.onEvent?.({
          type: "complete",
          data: {
            proofreading_id: "proof-zero",
            run_id: "run-zero",
            summary: {},
            scope: "run",
          },
        });
      },
    );

    const { result } = renderHook(() =>
      useProofreadAgent({
        token: "token",
        projectId: "proj",
        translationJobId: "job",
        hasTranslation: true,
        pushAssistant,
      }),
    );

    await act(async () => {
      await result.current.startProofread();
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("done");
    });

    expect(result.current.state.pages).toHaveLength(0);
    expect(result.current.state.lastMessage).toBe("교정이 완료되었습니다.");
    expect(api.fetchProofreadItems).not.toHaveBeenCalled();
    expect(pushAssistant).toHaveBeenCalled();
  });

  it("fetches additional pages when has_more is true", async () => {
    const pushAssistant = vi.fn();

    (api.fetchProofreadSummary as unknown as vi.Mock).mockResolvedValue(null);
    (api.fetchProofreadItems as unknown as vi.Mock).mockResolvedValue({
      events: [
        {
          type: "items",
          data: {
            project_id: "proj",
            run_id: "run-more",
            proofreading_id: "proof-more",
            tier: "quick",
            key: "style",
            chunk_index: 1,
            page: makePage({
              run_id: "resp-run-more-followup",
              chunk_id: "chunk-1",
              items: [{ ...pagedItem, k: "style-second" }],
              stats: { item_count: 1 },
              has_more: false,
              next_cursor: null,
            }),
          },
        },
      ],
      nextCursor: null,
      hasMore: false,
      total: 1,
    });

    (api.requestProofreading as unknown as vi.Mock).mockImplementation(
      async (
        _token: string,
        _projectId: string,
        _jobId: string,
        options?: { onEvent?: (event: Record<string, unknown>) => void },
      ) => {
        options?.onEvent?.({
          type: "stage",
          data: {
            proofreading_id: "proof-more",
            run_id: "run-more",
            tier: "quick",
            key: "summary",
            label: "Summary",
            status: "in_progress",
          },
        });
        options?.onEvent?.({
          type: "items",
          data: {
            project_id: "proj",
            run_id: "run-more",
            proofreading_id: "proof-more",
            tier: "quick",
            key: "style",
            chunk_index: 0,
            page: makePage({
              run_id: "resp-run-more-initial",
              chunk_id: "chunk-0",
              items: [{ ...pagedItem, k: "style-first" }],
              stats: { item_count: 1 },
              has_more: true,
              next_cursor: "cursor-1",
            }),
          },
        });
      },
    );

    const { result } = renderHook(() =>
      useProofreadAgent({
        token: "token",
        projectId: "proj",
        translationJobId: "job",
        hasTranslation: true,
        pushAssistant,
      }),
    );

    await act(async () => {
      await result.current.startProofread();
    });

    await waitFor(() => {
      expect(api.fetchProofreadItems).toHaveBeenCalledWith({
        token: "token",
        projectId: "proj",
        runId: "run-more",
        cursor: "cursor-1",
      });
    });

    await waitFor(() => {
      expect(result.current.state.pendingCursors.length).toBe(0);
    });

    expect(result.current.state.processedCursors).toContain("cursor-1");
    expect(result.current.state.pages.length).toBeGreaterThanOrEqual(2);
    const hasSecondPage = result.current.state.pages.some(
      (page) => page.chunk_id === "chunk-1",
    );
    expect(hasSecondPage).toBe(true);
    expect(pushAssistant).toHaveBeenCalled();
  });

  it("falls back to summary when reconnect fails", async () => {
    const pushAssistant = vi.fn();

    (api.fetchProofreadItems as unknown as vi.Mock).mockResolvedValue({
      events: [],
      nextCursor: null,
      hasMore: false,
      total: 0,
    });

    const summary = {
      projectId: "proj",
      runId: "run-fallback",
      runStatus: "done",
      runCreatedAt: null,
      runCompletedAt: new Date().toISOString(),
      lastLogAt: new Date().toISOString(),
      jobId: "job",
      translationFileId: "tf",
      memoryVersion: 1,
      finalTextHash: "hash",
      proofreading: {
        id: "proof-fallback",
        status: "completed",
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
      workflowRun: null,
      report: null,
      tierReports: {},
      updatedAt: new Date().toISOString(),
    };

    (api.fetchProofreadSummary as unknown as vi.Mock).mockResolvedValue(summary);

    (api.subscribeProofreadStream as unknown as vi.Mock).mockImplementation(
      () => {
        throw new Error("stream reconnect failed");
      },
    );

    (api.requestProofreading as unknown as vi.Mock).mockImplementation(
      async (
        _token: string,
        _projectId: string,
        _jobId: string,
        options?: { onEvent?: (event: Record<string, unknown>) => void },
      ) => {
        options?.onEvent?.({
          type: "stage",
          data: {
            proofreading_id: "proof-fallback",
            run_id: "run-fallback",
            tier: "quick",
            key: "summary",
            label: "Summary",
            status: "in_progress",
          },
        });
        options?.onEvent?.({
          type: "items",
          data: {
            project_id: "proj",
            run_id: "run-fallback",
            proofreading_id: "proof-fallback",
            tier: "quick",
            key: "summary",
            chunk_index: 0,
            page: makePage({
              run_id: "run-fallback",
              chunk_id: "chunk-0",
              items: [{ ...pagedItem, k: "style-first" }],
              stats: { item_count: 1 },
              has_more: false,
            }),
          },
        });

        throw new Error("stream failed");
      },
    );

    const { result } = renderHook(() =>
      useProofreadAgent({
        token: "token",
        projectId: "proj",
        translationJobId: "job",
        hasTranslation: true,
        pushAssistant,
      }),
    );

    await act(async () => {
      await result.current.startProofread();
    });

    await waitFor(() => {
      expect(api.fetchProofreadSummary).toHaveBeenCalledWith("token", "proj", {
        runId: "run-fallback",
        proofreadingId: "proof-fallback",
      });
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("done");
    });

    expect(result.current.state.run.status).toBe("done");
    expect(result.current.state.needsFollowup).toBe(false);
    expect(pushAssistant).toHaveBeenCalled();
  });
  it("sets needsFollowup when REST cursor fetch fails", async () => {
    const pushAssistant = vi.fn();

    (api.fetchProofreadItems as unknown as vi.Mock).mockImplementation(() => {
      throw new Error("network fail");
    });

    let resolveSummary: ((value: unknown) => void) | null = null;
    (api.fetchProofreadSummary as unknown as vi.Mock).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSummary = resolve;
        }),
    );

    (api.requestProofreading as unknown as vi.Mock).mockImplementation(
      async (
        _token: string,
        _projectId: string,
        _jobId: string,
        options?: { onEvent?: (event: Record<string, unknown>) => void },
      ) => {
        options?.onEvent?.({
          type: "items",
          data: {
            project_id: "proj",
            run_id: "run-retry",
            proofreading_id: "proof-retry",
            tier: "quick",
            key: "style",
            chunk_index: 0,
            page: makePage({
              run_id: "run-retry",
              chunk_id: "chunk-0",
              items: [{ ...pagedItem, k: "style-first" }],
              stats: { item_count: 1 },
              has_more: true,
              next_cursor: "cursor-err",
            }),
          },
        });
      },
    );

    const { result } = renderHook(() =>
      useProofreadAgent({
        token: "token",
        projectId: "proj",
        translationJobId: "job",
        hasTranslation: true,
        pushAssistant,
      }),
    );

    await act(async () => {
      await result.current.startProofread();
    });

    await act(async () => {
      resolveSummary?.(null);
    });

    expect(result.current.state.needsFollowup).toBe(false);
    expect(pushAssistant).toHaveBeenCalled();
  });

  it("reconnects to stream and completes after SSE interruption", async () => {
    const pushAssistant = vi.fn();

    (api.fetchProofreadItems as unknown as vi.Mock).mockResolvedValue({
      events: [],
      nextCursor: null,
      hasMore: false,
      total: 0,
    });

    (api.fetchProofreadSummary as unknown as vi.Mock).mockResolvedValue(null);

    (api.requestProofreading as unknown as vi.Mock).mockImplementation(
      async (
        _token: string,
        _projectId: string,
        _jobId: string,
        options?: { onEvent?: (event: Record<string, unknown>) => void },
      ) => {
        options?.onEvent?.({
          type: "stage",
          data: {
            proofreading_id: "proof-reconnect",
            run_id: "run-reconnect",
            tier: "quick",
            key: "summary",
            label: "Summary",
            status: "in_progress",
          },
        });
        options?.onEvent?.({
          type: "items",
          data: {
            project_id: "proj",
            run_id: "run-reconnect",
            proofreading_id: "proof-reconnect",
            tier: "quick",
            key: "summary",
            chunk_index: 0,
            page: makePage({
              run_id: "run-reconnect",
              chunk_id: "chunk-0",
              items: [{ ...pagedItem, k: "style-first" }],
              stats: { item_count: 1 },
              has_more: false,
              next_cursor: null,
            }),
          },
        });
      },
    );

    (api.subscribeProofreadStream as unknown as vi.Mock).mockImplementation(
      ({ onEvent }: { onEvent?: (event: Record<string, unknown>) => void }) => {
        onEvent?.({
          type: "items",
          data: {
            project_id: "proj",
            run_id: "run-reconnect",
            proofreading_id: "proof-reconnect",
            tier: "quick",
            key: "summary",
            chunk_index: 1,
            page: makePage({
              run_id: "run-reconnect",
              chunk_id: "chunk-1",
              items: [{ ...pagedItem, k: "style-second" }],
              stats: { item_count: 1 },
              has_more: false,
              next_cursor: null,
            }),
          },
        });
        onEvent?.({
          type: "tier_complete",
          data: {
            proofreading_id: "proof-reconnect",
            run_id: "run-reconnect",
            tier: "quick",
            itemCount: 2,
            summary: {
              countsBySubfeature: { summary: 2 },
              tier_issue_counts: { quick: 2 },
              item_count: 2,
              downshift_count: 0,
              forced_pagination_count: 0,
              cursor_retry_count: 0,
            },
          },
        });
        onEvent?.({
          type: "complete",
          data: {
            proofreading_id: "proof-reconnect",
            run_id: "run-reconnect",
            scope: "run",
            summary: {
              meta: {
                schemaVersion: "1.0",
                source: { lang: "ko", path: "src" },
                target: { lang: "en", path: "tgt" },
                alignment: "paragraph",
                generatedAt: new Date().toISOString(),
              },
              results: [],
              summary: {
                countsBySubfeature: { summary: 2 },
                tier_issue_counts: { quick: 2 },
                downshift_count: 0,
                forced_pagination_count: 0,
                cursor_retry_count: 0,
                notes_ko: "교정 완료",
                notes_en: "Proofreading complete",
              },
            },
          },
        });
        return () => undefined;
      },
    );

    const { result } = renderHook(() =>
      useProofreadAgent({
        token: "token",
        projectId: "proj",
        translationJobId: "job",
        hasTranslation: true,
        pushAssistant,
      }),
    );

    await act(async () => {
      await result.current.startProofread();
    });

    await waitFor(() => {
      expect(api.subscribeProofreadStream).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("done");
    });

    expect(result.current.state.pendingCursors).toHaveLength(0);
    expect(result.current.state.needsFollowup).toBe(false);
    expect(result.current.state.tierSummaries.quick?.itemCount).toBe(2);
    expect(pushAssistant).toHaveBeenCalled();
  });

  it("marks run recovering on stage error and clears retry flags after success", async () => {
    const pushAssistant = vi.fn();

    (api.fetchProofreadSummary as unknown as vi.Mock).mockResolvedValue(null);
    (api.fetchProofreadItems as unknown as vi.Mock).mockResolvedValue({
      events: [],
      nextCursor: null,
      hasMore: false,
      total: 0,
    });

    (api.subscribeProofreadStream as unknown as vi.Mock).mockReturnValue(() => undefined);

    let replayEvent: ((event: Record<string, unknown>) => void) | undefined;
    (api.requestProofreading as unknown as vi.Mock).mockImplementation(
      async (
        _token: string,
        _projectId: string,
        _jobId: string,
        options?: { onEvent?: (event: Record<string, unknown>) => void },
      ) => {
        replayEvent = options?.onEvent;
        options?.onEvent?.({
          type: "stage",
          data: {
            proofreading_id: "proof-backoff",
            run_id: "run-backoff",
            tier: "quick",
            key: "summary",
            label: "Summary",
            status: "error",
          },
        });
      },
    );

    const { result } = renderHook(() =>
      useProofreadAgent({
        token: "token",
        projectId: "proj",
        translationJobId: "job",
        hasTranslation: true,
        pushAssistant,
      }),
    );

    await act(async () => {
      await result.current.startProofread();
    });

    await waitFor(() => {
      expect(result.current.state.run.status).toBe("recovering");
      expect(result.current.state.run.willRetry).toBe(true);
    });

    await act(async () => {
      replayEvent?.({
        type: "stage",
        data: {
          proofreading_id: "proof-backoff",
          run_id: "run-backoff",
          tier: "quick",
          key: "summary",
          label: "Summary",
          status: "done",
        },
      });
    });
    expect(result.current.state.run.status).toBe("running");
    expect(result.current.state.run.willRetry).toBe(false);

    await act(async () => {
      replayEvent?.({
        type: "complete",
        data: {
          proofreading_id: "proof-backoff",
          run_id: "run-backoff",
          scope: "run",
          summary: {
            meta: {
              schemaVersion: "1.0",
              source: { lang: "ko", path: "src" },
              target: { lang: "en", path: "tgt" },
              alignment: "paragraph",
              generatedAt: new Date().toISOString(),
            },
            results: [],
            summary: {
              countsBySubfeature: {},
              tier_issue_counts: { quick: 0 },
              downshift_count: 0,
              forced_pagination_count: 0,
              cursor_retry_count: 0,
              notes_ko: "교정 완료",
              notes_en: "Proofreading complete",
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe("done");
    });
    expect(pushAssistant).toHaveBeenCalled();
  });
});
