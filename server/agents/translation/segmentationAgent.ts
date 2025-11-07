import {
  segmentCanonicalText,
  type CanonicalSegmentationResult,
} from "../../services/translation/segmentationEngine";
import {
  getTranslationSegmentationMode,
  type SegmentationMode,
} from "../../config/appControlConfiguration";

export interface OriginSegment {
  id: string;
  index: number;
  text: string;
  paragraphIndex: number;
  sentenceIndex: number | null;
}

export interface SegmentationResult {
  mode: SegmentationMode;
  sourceHash: string;
  segments: OriginSegment[];
  canonical: CanonicalSegmentationResult;
}

export interface SegmentationAgentOptions {
  text: string;
  projectId: string;
  modeOverride?: SegmentationMode;
  maxSegmentLength?: number;
  sourceLanguage?: string | null;
  targetLanguage?: string | null;
}

export async function segmentOriginText(
  options: SegmentationAgentOptions,
): Promise<SegmentationResult> {
  const modeOverride = options.modeOverride ?? getTranslationSegmentationMode();
  const canonical = await segmentCanonicalText({
    text: options.text,
    projectId: options.projectId,
    modeOverride,
    sourceLanguage: options.sourceLanguage,
    targetLanguage: options.targetLanguage,
  });

  const segments: OriginSegment[] = canonical.segments.map((segment) => ({
    id: segment.id,
    index: segment.segmentOrder,
    text: segment.text,
    paragraphIndex: segment.paragraphIndex,
    sentenceIndex: segment.sentenceIndex,
  }));

  return {
    mode: canonical.mode,
    sourceHash: canonical.sourceHash,
    segments,
    canonical,
  };
}
