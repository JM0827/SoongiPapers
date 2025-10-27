const pipelineGlobalFlag =
  (process.env.TRANSLATION_PIPELINE_V2_ENABLED ?? "false").trim().toLowerCase();

const pipelineProjectEnv = (process.env.TRANSLATION_PIPELINE_V2_PROJECTS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

const pipelineProjectSet = new Set(pipelineProjectEnv);

const isGlobalPipelineEnabled =
  pipelineGlobalFlag === "true" || pipelineGlobalFlag === "1";

export function isTranslationPipelineV2Enabled(
  projectId?: string | null,
): boolean {
  if (isGlobalPipelineEnabled) {
    return true;
  }
  if (!projectId) {
    return false;
  }
  return pipelineProjectSet.has(projectId);
}
