import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppShell } from "../components/layout/AppShell";
import { ChatOrchestrator } from "../components/chat/ChatOrchestrator";
import { RightPanel } from "../components/layout/RightPanel";
import { projectKeys } from "../hooks/useProjectData";
import { useProjectContext } from "../hooks/useProjectContext";

export const Studio = () => {
  const queryClient = useQueryClient();
  const {
    snapshot,
    content: projectContent,
    jobs,
    refresh,
    isLoading: isContextLoading,
    isJobsLoading,
  } = useProjectContext();
  const activeProjectId = snapshot.projectId;

  const invalidateContent = useCallback(() => {
    void refresh("all");
  }, [refresh]);

  const handleOriginSaved = useCallback(() => {
    invalidateContent();
  }, [invalidateContent]);

  const handleTranslationCompleted = useCallback(() => {
    invalidateContent();
  }, [invalidateContent]);

  const handleProofreadCompleted = useCallback(() => {
    invalidateContent();
  }, [invalidateContent]);

  const handleQualityCompleted = useCallback(() => {
    invalidateContent();
    if (activeProjectId) {
      queryClient.invalidateQueries({
        queryKey: projectKeys.qualityHistory(activeProjectId),
      });
    }
  }, [invalidateContent, activeProjectId, queryClient]);

  const handleProfileUpdated = useCallback(() => {
    void refresh("content");
    queryClient.invalidateQueries({ queryKey: projectKeys.list });
  }, [refresh, queryClient]);

  return (
    <AppShell
      right={
        <RightPanel
          content={projectContent ?? undefined}
          jobs={jobs}
          isJobsLoading={isJobsLoading}
          isContentLoading={isContextLoading}
          onProfileUpdated={handleProfileUpdated}
          onRefreshContent={() => refresh("content")}
        />
      }
    >
      <div className="flex h-full flex-col gap-4 p-6">
        <div className="grid flex-1 grid-rows-[1fr_auto]">
          <ChatOrchestrator
            content={projectContent}
            snapshot={snapshot}
            refreshProjectContext={refresh}
            onOriginSaved={handleOriginSaved}
            onTranslationCompleted={handleTranslationCompleted}
            onProofreadCompleted={handleProofreadCompleted}
            onQualityCompleted={handleQualityCompleted}
            onProfileUpdated={handleProfileUpdated}
          />
        </div>
      </div>
    </AppShell>
  );
};
