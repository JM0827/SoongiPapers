import type {
  GuardFindingDetail,
  GuardBooleans,
} from "@bookko/translation-types";
import type { OriginSegment } from "../../agents/translation/segmentationAgent";
import type { TranslationReviseSegmentResult } from "../../agents/translation/reviseAgent";

export interface MicroCheckOptions {
  originSegments: OriginSegment[];
  revisedSegments: TranslationReviseSegmentResult[];
}

export interface MicroCheckSegmentResult {
  segmentId: string;
  textTarget: string;
  guards: GuardBooleans;
  notes: {
    guardFindings: GuardFindingDetail[];
  };
}

export interface MicroCheckResult {
  segments: MicroCheckSegmentResult[];
  violationCount: number;
}

const LENGTH_RATIO_MIN = 0.7;
const LENGTH_RATIO_MAX = 1.3;

export function runMicroChecks(options: MicroCheckOptions): MicroCheckResult {
  const originMap = new Map(
    options.originSegments.map((segment) => [segment.id, segment.text]),
  );
  const segments: MicroCheckSegmentResult[] = [];
  let violationCount = 0;

  options.revisedSegments.forEach((segment) => {
    const origin = originMap.get(segment.segment_id) ?? "";
    const originLength = Math.max(1, origin.length);
    const target = segment.revised_segment ?? "";
    const ratio = target.length / originLength;
    const lengthOk = ratio >= LENGTH_RATIO_MIN && ratio <= LENGTH_RATIO_MAX;

    const findings: GuardFindingDetail[] = [];
    if (!lengthOk) {
      findings.push({
        type: "length_ratio",
        ok: false,
        summary: `Length ratio ${ratio.toFixed(2)} outside ${LENGTH_RATIO_MIN}-${LENGTH_RATIO_MAX}`,
        segmentId: segment.segment_id,
        severity: "warn",
      });
      violationCount += 1;
    }

    const guards: GuardBooleans = {
      allOk: lengthOk,
      lengthOk,
    };

    segments.push({
      segmentId: segment.segment_id,
      textTarget: target,
      guards,
      notes: {
        guardFindings: findings,
      },
    });
  });

  return { segments, violationCount };
}
