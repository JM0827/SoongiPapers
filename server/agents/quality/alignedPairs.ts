import TranslationDraft from "../../models/TranslationDraft";
import TranslationSegment from "../../models/TranslationSegment";
import type {
  TranslationDraftDocument,
  TranslationDraftSegmentDocument,
} from "../../models/TranslationDraft";
import { splitSentencesByLang } from "../proofreading/utils";

export interface AlignedPair {
  source: string;
  translated: string;
  segmentId?: string | null;
  index: number;
}

export interface AlignedPairSet {
  pairs: AlignedPair[];
  source: "segment" | "draft" | "fallback";
  metadata?: {
    draftId?: string;
    runOrder?: number;
    segmentCount?: number;
    translationFileId?: string;
    jobId?: string | null;
  };
}

const sanitizeSegment = (value: string | null | undefined): string => {
  if (!value) return "";
  return value.replace(/\r\n?/g, "\n").trim();
};

const buildPairsFromDraft = (
  draft: TranslationDraftDocument,
): AlignedPairSet => {
  const segments = Array.isArray(draft.segments) ? draft.segments : [];
  const pairs = segments
    .map((segment: TranslationDraftSegmentDocument, index: number) => {
      const source = sanitizeSegment(segment.origin_segment);
      const translated = sanitizeSegment(segment.translation_segment);
      if (!source && !translated) {
        return null;
      }
      return {
        source,
        translated,
        segmentId: segment.segment_id,
        index,
      } as AlignedPair;
    })
    .filter((entry): entry is AlignedPair => entry !== null);

  return {
    pairs,
    source: "draft",
    metadata: {
      draftId: draft._id?.toString?.() ?? undefined,
      runOrder: draft.run_order,
      segmentCount: pairs.length,
    },
  };
};

const buildPairsFallback = (source: string, translated: string): AlignedPairSet => {
  const koSentences = splitSentencesByLang(source, "ko");
  const enSentences = splitSentencesByLang(translated, "en");
  const count = Math.max(koSentences.length, enSentences.length);
  const pairs: AlignedPair[] = [];

  for (let index = 0; index < count; index += 1) {
    const sourceSentence = sanitizeSegment(koSentences[index]);
    const translatedSentence = sanitizeSegment(enSentences[index]);
    if (!sourceSentence && !translatedSentence) {
      continue;
    }
    pairs.push({
      source: sourceSentence,
      translated: translatedSentence,
      index,
    });
  }

  return {
    pairs,
    source: "fallback",
    metadata: {
      segmentCount: pairs.length,
    },
  };
};

const buildPairsFromTranslationSegments = async (
  projectId: string,
  jobId: string,
): Promise<AlignedPairSet | null> => {
  const segments = await TranslationSegment.find({
    project_id: projectId,
    job_id: jobId,
    variant: "final",
  })
    .sort({ segment_index: 1 })
    .lean();

  if (!segments.length) {
    return null;
  }

  const pairs = segments
    .map((segment, index) => {
      const source = sanitizeSegment(segment.origin_segment);
      const translated = sanitizeSegment(segment.translation_segment);
      if (!source && !translated) {
        return null;
      }
      return {
        source,
        translated,
        segmentId: segment.segment_id ?? null,
        index: segment.segment_index ?? index,
      } as AlignedPair;
    })
    .filter((entry): entry is AlignedPair => entry !== null);

  if (!pairs.length) {
    return null;
  }

  return {
    pairs,
    source: "segment",
    metadata: {
      segmentCount: pairs.length,
      translationFileId: segments[0]?.translation_file_id?.toString?.(),
      jobId,
    },
  };
};

export async function buildAlignedPairSet(params: {
  source: string;
  translated: string;
  projectId?: string | null;
  jobId?: string | null;
}): Promise<AlignedPairSet> {
  const { projectId, jobId } = params;

  if (projectId && jobId) {
    const segmentPairs = await buildPairsFromTranslationSegments(
      projectId,
      jobId,
    );
    if (segmentPairs) {
      return segmentPairs;
    }

    try {
      const draft = await TranslationDraft.findOne({
        project_id: projectId,
        job_id: jobId,
        status: "succeeded",
      })
        .sort({ run_order: -1 })
        .lean<TranslationDraftDocument>();

      if (draft && Array.isArray(draft.segments) && draft.segments.length) {
        const pairsFromDraft = buildPairsFromDraft(draft);
        if (pairsFromDraft.pairs.length) {
          return pairsFromDraft;
        }
      }
    } catch (error) {
      // swallow and fallback
    }
  }

  return buildPairsFallback(params.source, params.translated);
}
