export interface SafeExtractedOpenAIResponse {
  parsedJson?: unknown;
  text?: string;
  requestId?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  repairApplied?: boolean;
  status?: string | null;
  finishReason?: string | null;
  incompleteReason?: string | null;
}

const JSON_CONTROL_CHAR_REGEX =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const collectOutputText = (resp: any): string | undefined => {
  const direct = resp?.output_text;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (Array.isArray(direct)) {
    const joined = direct.filter((s) => typeof s === "string").join("\n");
    if (joined.trim()) return joined.trim();
  }

  const items = Array.isArray(resp?.output) ? resp.output : [];
  let buf = "";
  for (const item of items) {
    if (item?.type !== "message") continue;
    const contents = Array.isArray(item?.content) ? item.content : [];
    for (const c of contents) {
      if (typeof c?.text === "string") buf += c.text;
    }
  }
  const trimmed = buf.trim();
  return trimmed ? trimmed : undefined;
};

const isMaxBudgetStop = (res: any) =>
  res?.status === "incomplete" &&
  res?.incomplete_details?.reason === "max_output_tokens";

const balanceStructuralPairs = (
  value: string,
  open: string,
  close: string,
): { value: string; applied: boolean } => {
  const openReg = new RegExp(`\\${open}`, "g");
  const closeReg = new RegExp(`\\${close}`, "g");
  const openCount = (value.match(openReg) ?? []).length;
  const closeCount = (value.match(closeReg) ?? []).length;
  if (openCount > closeCount) {
    return {
      value: value + close.repeat(openCount - closeCount),
      applied: true,
    };
  }
  return { value, applied: false };
};

const repairJsonString = (raw: string): { value: string; applied: boolean } => {
  let value = raw.trim();
  let applied = false;

  const sanitized = value.replace(JSON_CONTROL_CHAR_REGEX, "");
  if (sanitized !== value) {
    value = sanitized;
    applied = true;
  }

  const lastStructuralIndex = Math.max(
    value.lastIndexOf("}"),
    value.lastIndexOf("]"),
  );
  if (lastStructuralIndex !== -1 && lastStructuralIndex < value.length - 1) {
    value = value.slice(0, lastStructuralIndex + 1).trimEnd();
    applied = true;
  }

  const braceResult = balanceStructuralPairs(value, "{", "}");
  value = braceResult.value;
  applied = applied || braceResult.applied;

  const bracketResult = balanceStructuralPairs(value, "[", "]");
  value = bracketResult.value;
  applied = applied || bracketResult.applied;

  const quoteCount = (value.match(/"/g) ?? []).length;
  if (quoteCount % 2 !== 0) {
    value += '"';
    applied = true;
  }

  return { value, applied };
};

export function safeExtractOpenAIResponse(
  resp: any,
): SafeExtractedOpenAIResponse {
  const usage = resp?.usage
    ? {
        prompt_tokens:
          resp.usage.prompt_tokens ?? resp.usage.input_tokens ?? undefined,
        completion_tokens:
          resp.usage.completion_tokens ?? resp.usage.output_tokens ?? undefined,
        total_tokens: resp.usage.total_tokens,
      }
    : undefined;

  let parsed = Array.isArray(resp?.output_parsed)
    ? resp.output_parsed[0]
    : undefined;

  const originalText = collectOutputText(resp);
  let normalizedText = originalText;
  let repairApplied = false;

  if (!parsed && Array.isArray(resp?.output)) {
    const contents = resp.output.flatMap((item: any) => item?.content ?? []);
    const parsedEntry = contents.find(
      (entry: any) =>
        entry?.parsed_json !== undefined &&
        (entry?.type === "output_parsed" || entry?.type === "json_schema"),
    );
    if (parsedEntry?.parsed_json !== undefined) {
      parsed = parsedEntry.parsed_json;
    }
  }

  if (!parsed && normalizedText) {
    try {
      parsed = JSON.parse(normalizedText);
    } catch (_err) {
      const repaired = repairJsonString(normalizedText);
      if (repaired.applied) {
        normalizedText = repaired.value;
        try {
          parsed = JSON.parse(normalizedText);
          repairApplied = true;
        } catch (
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          __repairErr
        ) {
          // swallow parse error after repair; fallback handled below
        }
      }
    }
  }

  if (!parsed && !normalizedText) {
    if (isMaxBudgetStop(resp)) {
      parsed = {
        version: "v2",
        items: [],
      };
    } else {
      try {
        const preview = JSON.stringify(resp)?.slice(0, 2000);
        console.error("[LLM] Empty response payload", preview);
      } catch (_logErr) {
        console.error("[LLM] Empty response payload (unable to stringify)");
      }
      throw new Error("Empty response from OpenAI (no text, no message)");
    }
  }

  const status: string | null =
    typeof resp?.status === "string" ? resp.status : null;
  let finishReason: string | null = null;
  const outputItems = Array.isArray(resp?.output) ? resp.output : [];
  for (const item of outputItems) {
    const candidate = (item as { finish_reason?: unknown }).finish_reason;
    if (typeof candidate === "string" && candidate.trim()) {
      finishReason = candidate.trim();
      break;
    }
  }
  if (!finishReason && status === "incomplete") {
    finishReason = "length";
  }
  const incompleteReason: string | null =
    typeof resp?.incomplete_details?.reason === "string"
      ? resp.incomplete_details.reason
      : null;
  if (
    !finishReason &&
    incompleteReason &&
    incompleteReason.toLowerCase() === "max_output_tokens"
  ) {
    finishReason = "length";
  }

  return {
    parsedJson: parsed,
    text: normalizedText,
    requestId: resp?.id,
    usage,
    repairApplied,
    status,
    finishReason,
    incompleteReason,
  };
}

export function isFatalParamErr(error: unknown): boolean {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : String(error ?? "");
  if (!message) return false;
  return (
    message.includes("Unsupported parameter") ||
    (message.includes("response_format") && message.includes("text.format"))
  );
}

export function estimateTokens(text?: string | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}
