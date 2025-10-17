import { isLineJoinerEnabled } from "../config/appControlConfiguration";

export interface JoinerOptions {
  keepListAndHeadingBreaks?: boolean;
  mergeContinuationLines?: boolean;
  mergeAfterSoftPunctuation?: boolean;
  respectQuoteBlocks?: boolean;
}

export const DEFAULT_JOINER: Required<JoinerOptions> = {
  keepListAndHeadingBreaks: true,
  mergeContinuationLines: true,
  mergeAfterSoftPunctuation: true,
  respectQuoteBlocks: true,
};

// -------- Regex helpers (공통) --------
export const reCRLF = /\r\n?/g;
export const reBlank = /^\s*$/;

export const reHeading = /^\s{0,3}#{1,6}\s+\S/;
export const reListBullet = /^\s{0,3}(\d+\.\s+|[•*-]\s+|\(\d+\)\s+)/;

export const reOpenQuoteChar = /[“"‘'（(「『〈<\[]/;
export const reCloseQuoteChar = /[”"’'）)」』〉>\]]/;

const reInQuoteOpen = /[“"‘'「『〈<\[]/g;
const reInQuoteClose = /[”"’'」』〉>\]]/g;

export const reLowerOrHangulStart = /^[a-z가-힣]/;
export const reTerminalStrong = /[.!?…‥。！？]['"”’）)」』〉>\]]*\s*$/;
export const reTerminalSoft = /[,;:、，]['"”’）)」』〉>\]]*\s*$/;

// PDF 하이픈(영어 단어 단절) 전용
export const reHyphenEnd = /[A-Za-z]-\s*$/;

export const reAllWhitespace = /\s+/g;

export function normalizeEol(value: string): string {
  return value.replace(reCRLF, "\n");
}

export function quoteBalance(line: string): number {
  const opens = (line.match(reInQuoteOpen) || []).length;
  const closes = (line.match(reInQuoteClose) || []).length;
  return opens - closes;
}

export type Join = "none" | "space" | "nospace";

export function joinStrategy(
  prev: string,
  curr: string,
  opt: Required<JoinerOptions>,
  inQuoteBlock: boolean,
  allowHyphenNoSpace = false,
): Join {
  if (!isLineJoinerEnabled()) {
    return "none";
  }

  const a = prev.trimEnd();
  const b = curr.trimStart();

  if (
    opt.keepListAndHeadingBreaks &&
    (reHeading.test(b) || reListBullet.test(b))
  ) {
    return "none";
  }

  if (allowHyphenNoSpace && /[A-Za-z]-\s*$/.test(a) && /^[A-Za-z]/.test(b)) {
    return "nospace";
  }

  if (reTerminalStrong.test(a)) {
    return "none";
  }

  if (opt.respectQuoteBlocks && inQuoteBlock) {
    return "space";
  }

  if (opt.mergeAfterSoftPunctuation && reTerminalSoft.test(a)) {
    return "space";
  }

  if (
    opt.mergeContinuationLines &&
    (reLowerOrHangulStart.test(b) || reOpenQuoteChar.test(b.charAt(0) ?? ""))
  ) {
    return "space";
  }

  if (!reTerminalStrong.test(a)) {
    return "space";
  }

  return "none";
}
