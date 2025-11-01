import type {
  GuardBooleans,
  GuardFindingDetail,
  ProjectMemory,
  SequentialStageJobSegment,
  SequentialStageResult,
} from "../../agents/translation";

const HANGUL_REGEX = /[\uAC00-\uD7A3]+/g;
const WORD_NORMALIZER = /[^\p{Script=Hangul}\p{Script=Latin}0-9\s'-]/gu;

interface GuardEvaluationContext {
  direction: "ko→en" | "en→ko";
  memory?: ProjectMemory | null;
}

type GuardCheckResult = {
  ok: boolean;
  finding?: GuardFindingDetail;
};

const LENGTH_RATIO_MIN = 0.45;
const LENGTH_RATIO_MAX = 2.4;
const BACKTRANSLATION_MIN_SIMILARITY = 0.5;

export async function evaluateGuards(
  context: GuardEvaluationContext,
  stageResults: SequentialStageResult[],
  segments: SequentialStageJobSegment[],
): Promise<SequentialStageResult[]> {
  const segmentById = new Map(
    segments.map((segment) => [segment.segmentId, segment]),
  );

  return stageResults.map((result) => {
    const segment = segmentById.get(result.segmentId);
    const source = segment?.textSource ?? "";
    const target = result.textTarget ?? "";
    const baseGuards: GuardBooleans = { ...(result.guards ?? {}) };
    const findings: GuardFindingDetail[] = [];

    const lengthRatio = computeLengthRatio(source, target);
    const parityOk =
      lengthRatio >= LENGTH_RATIO_MIN && lengthRatio <= LENGTH_RATIO_MAX;
    if (!parityOk) {
      findings.push({
        type: "length-parity",
        ok: false,
        summary: `Length ratio ${lengthRatio.toFixed(2)} outside ${LENGTH_RATIO_MIN}-${LENGTH_RATIO_MAX}.`,
        severity: "warn",
        segmentId: segment?.segmentId,
        details: {
          lengthRatio,
          sourceLength: source.length,
          targetLength: target.length,
        },
      });
    }

    const entityCheck = evaluateEntityGuard({
      source,
      target,
      memory: context.memory,
      direction: context.direction,
      segmentId: segment?.segmentId,
    });
    if (!entityCheck.ok && entityCheck.finding) {
      findings.push(entityCheck.finding);
    }

    const termCheck = evaluateTermMapGuard({
      source,
      target,
      memory: context.memory,
      direction: context.direction,
      segmentId: segment?.segmentId,
    });
    if (!termCheck.ok && termCheck.finding) {
      findings.push(termCheck.finding);
    }

    const registerCheck = evaluateRegisterGuard({
      target,
      memory: context.memory,
      direction: context.direction,
      segmentId: segment?.segmentId,
    });
    if (!registerCheck.ok && registerCheck.finding) {
      findings.push(registerCheck.finding);
    }

    const backTranslationCheck = evaluateBackTranslationGuard({
      source,
      target,
      backTranslation: extractBackTranslation(result.notes),
      segmentId: segment?.segmentId,
    });
    if (!backTranslationCheck.ok && backTranslationCheck.finding) {
      findings.push(backTranslationCheck.finding);
    }

    const metaphorOk = baseGuards.metaphorOk ?? true;

    const guards: GuardBooleans = {
      ...baseGuards,
      parityOk,
      namesOk: entityCheck.ok,
      culturalOk: termCheck.ok,
      registerOk: registerCheck.ok,
      backTranslationOk: backTranslationCheck.ok,
      metaphorOk,
    };
    guards.allOk =
      guards.parityOk !== false &&
      guards.namesOk !== false &&
      guards.culturalOk !== false &&
      guards.registerOk !== false &&
      guards.backTranslationOk !== false &&
      guards.metaphorOk !== false;

    const existingNotes = toRecord(result.notes);
    if (segment?.segmentId) {
      existingNotes.segmentId = segment.segmentId;
    }
    if (findings.length) {
      existingNotes.guardFindings = [
        ...(Array.isArray(existingNotes.guardFindings)
          ? existingNotes.guardFindings
          : []),
        ...findings,
      ];
    }

    return {
      ...result,
      guards,
      notes: findings.length ? existingNotes : result.notes,
    };
  });
}

function computeLengthRatio(source: string, target: string): number {
  const safeSource = source && source.trim().length ? source.length : 1;
  return target && target.trim().length ? target.length / safeSource : 0;
}

function evaluateEntityGuard(params: {
  source: string;
  target: string;
  memory?: ProjectMemory | null;
  direction: GuardEvaluationContext["direction"];
  segmentId?: string;
}): GuardCheckResult {
  const { source, target, memory, direction, segmentId } = params;
  const normalizedTarget = normalizeForMatch(target);
  if (!memory?.named_entities?.length) {
    return { ok: true };
  }

  const missing: string[] = [];
  for (const entity of memory.named_entities) {
    const sourceLabel =
      direction === "ko→en" ? entity.label?.source : entity.label?.target;
    const expectedLabel =
      direction === "ko→en" ? entity.label?.target : entity.label?.source;
    if (!sourceLabel || !expectedLabel) continue;

    const includesSource = includesLoose(source, sourceLabel);
    if (!includesSource) continue;

    const alternateTargets = [expectedLabel]
      .concat(
        entity.aliases?.map((alias) =>
          direction === "ko→en" ? alias.target : alias.source,
        ) ?? [],
      )
      .filter((value): value is string => Boolean(value));

    const hasTarget = alternateTargets.some((candidate) =>
      includesLoose(normalizedTarget, candidate),
    );
    if (!hasTarget) {
      missing.push(expectedLabel);
    }
  }

  if (!missing.length) {
    return { ok: true };
  }

  return {
    ok: false,
    finding: {
      type: "named-entity",
      ok: false,
      summary: `Missing mapped entity translation for: ${missing.join(", ")}`,
      severity: "error",
      segmentId,
      details: { missing },
    },
  };
}

function evaluateTermMapGuard(params: {
  source: string;
  target: string;
  memory?: ProjectMemory | null;
  direction: GuardEvaluationContext["direction"];
  segmentId?: string;
}): GuardCheckResult {
  const { source, target, memory, direction, segmentId } = params;
  const termMap = memory?.term_map?.source_to_target ?? null;
  if (!termMap || !Object.keys(termMap).length) {
    return { ok: true };
  }

  const normalizedSource = normalizeForMatch(source);
  const normalizedTarget = normalizeForMatch(target);

  const violations: Array<{ source: string; expected: string }> = [];

  for (const [rawSource, rawTarget] of Object.entries(termMap)) {
    if (!rawSource || !rawTarget) continue;
    const sourceTerm = direction === "ko→en" ? rawSource : rawTarget;
    const targetTerm = direction === "ko→en" ? rawTarget : rawSource;

    if (!includesLoose(normalizedSource, sourceTerm)) continue;
    if (includesLoose(normalizedTarget, targetTerm)) continue;

    violations.push({ source: sourceTerm, expected: targetTerm });
  }

  if (!violations.length) {
    return { ok: true };
  }

  return {
    ok: false,
    finding: {
      type: "term-map",
      ok: false,
      summary: `Term map mismatch for ${violations.length} entr${violations.length === 1 ? "y" : "ies"}.`,
      severity: "error",
      segmentId,
      details: { violations },
    },
  };
}

function evaluateRegisterGuard(params: {
  target: string;
  memory?: ProjectMemory | null;
  direction: GuardEvaluationContext["direction"];
  segmentId?: string;
}): GuardCheckResult {
  const { target, direction, memory, segmentId } = params;
  if (direction === "ko→en") {
    return { ok: true };
  }

  if (!target) {
    return { ok: true };
  }

  const honorificMarkers = target.match(HANGUL_REGEX) ?? [];
  if (!honorificMarkers.length) {
    return { ok: true };
  }

  if (!memory?.character_sheet?.length) {
    return { ok: true };
  }

  const excessiveHonorifics = honorificMarkers.length > target.length / 2;
  if (!excessiveHonorifics) {
    return { ok: true };
  }

  return {
    ok: false,
    finding: {
      type: "register",
      ok: false,
      summary:
        "Honorific density suggests incorrect register for target audience.",
      severity: "warn",
      segmentId,
      details: {
        honorificCount: honorificMarkers.length,
        targetLength: target.length,
      },
    },
  };
}

function evaluateBackTranslationGuard(params: {
  source: string;
  target: string;
  backTranslation?: string | null;
  segmentId?: string;
}): GuardCheckResult {
  const { source, backTranslation, segmentId } = params;
  if (!backTranslation) {
    return { ok: true };
  }

  const similarity = computeSimilarity(
    normalizeForMatch(source),
    normalizeForMatch(backTranslation),
  );
  if (similarity >= BACKTRANSLATION_MIN_SIMILARITY) {
    return { ok: true };
  }

  return {
    ok: false,
    finding: {
      type: "back-translation",
      ok: false,
      summary: `Back-translation similarity ${similarity.toFixed(2)} below ${BACKTRANSLATION_MIN_SIMILARITY}.`,
      severity: "warn",
      segmentId,
      details: { similarity, backTranslation },
    },
  };
}

function extractBackTranslation(notes: unknown): string | null {
  if (!notes || typeof notes !== "object") return null;
  const record = notes as Record<string, unknown>;
  const value = record.backTranslation ?? record.back_translation;
  return typeof value === "string" && value.trim().length ? value : null;
}

function includesLoose(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  const normalizedHaystack = normalizeForMatch(haystack);
  const normalizedNeedle = normalizeForMatch(needle);
  if (!normalizedHaystack || !normalizedNeedle) return false;
  if (normalizedHaystack.includes(normalizedNeedle)) return true;

  const haystackTokens = new Set(splitTokens(normalizedHaystack));
  const needleTokens = splitTokens(normalizedNeedle);
  if (!needleTokens.length) return false;
  const matches = needleTokens.filter((token) =>
    haystackTokens.has(token),
  ).length;
  return matches >= Math.max(1, Math.floor(needleTokens.length * 0.6));
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(WORD_NORMALIZER, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTokens(value: string): string[] {
  return value.split(/\s+/g).filter(Boolean);
}

function computeSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const tokensA = new Set(splitTokens(a));
  const tokensB = new Set(splitTokens(b));
  if (!tokensA.size || !tokensB.size) {
    return 0;
  }

  let matches = 0;
  tokensA.forEach((token) => {
    if (tokensB.has(token)) {
      matches += 1;
    }
  });

  return matches / Math.max(tokensA.size, tokensB.size);
}

function toRecord(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, any>;
}
