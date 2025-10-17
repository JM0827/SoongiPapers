const ZERO_WIDTH_CHARS = new Set([
  "\u{FEFF}",
  "\u{200B}",
  "\u{200C}",
  "\u{200D}",
  "\u{2060}",
  "\u{180E}",
  "\u{034F}",
]);

const WIDE_SPACE_REPLACEMENTS = new Map<string, string>([
  ["\u{00A0}", " "],
  ["\u{1680}", " "],
  ["\u{2000}", " "],
  ["\u{2001}", " "],
  ["\u{2002}", " "],
  ["\u{2003}", " "],
  ["\u{2004}", " "],
  ["\u{2005}", " "],
  ["\u{2006}", " "],
  ["\u{2007}", " "],
  ["\u{2008}", " "],
  ["\u{2009}", " "],
  ["\u{200A}", " "],
  ["\u{202F}", " "],
  ["\u{205F}", " "],
  ["\u{3000}", " "],
]);

const isDisallowedControlChar = (code: number): boolean =>
  (code >= 0x00 && code <= 0x08) ||
  code === 0x0b ||
  code === 0x0c ||
  (code >= 0x0e && code <= 0x1f) ||
  (code >= 0x7f && code <= 0x9f);

const scrubSpecialCharacters = (input: string): string => {
  if (!input) return "";
  let output = "";
  for (const char of input) {
    if (ZERO_WIDTH_CHARS.has(char)) {
      continue;
    }
    const replacement = WIDE_SPACE_REPLACEMENTS.get(char);
    if (replacement !== undefined) {
      output += replacement;
      continue;
    }
    if (isDisallowedControlChar(char.charCodeAt(0))) {
      continue;
    }
    output += char;
  }
  return output;
};

/**
 * HWP 추출 텍스트에서 흔한 문제를 정규화한다.
 * - 제로폭/비표준 공백/컨트롤 문자 제거
 * - CRLF -> LF
 * - 행끝 공백 제거
 * - 단일 개행은 문장 내부 줄바꿈으로 간주하여 ' '로 병합
 * - 연속 개행(>=2)만 문단 경계로 유지
 * - BOM 제거
 * - 유니코드 정규화(NFC)
 */
export function normalizeHwpText(raw: string): string {
  if (!raw) return "";

  let s = scrubSpecialCharacters(raw);

  // 1) 줄바꿈 통일 CRLF -> LF
  s = s.replace(/\r\n?/g, "\n");

  // 2) 라인 끝 공백 제거
  s = s.replace(/[ \t]+\n/g, "\n");

  // 3) 단일 개행은 문장 내부 줄바꿈으로 보고 공백으로 치환 (연속 개행은 유지)
  s = s.replace(/([^\n])\n(?!\n)/g, "$1 ");

  // 4) 공백 정리
  s = s.replace(/[ \t]{2,}/g, " ");
  s = s.replace(/\s+([,!?;:%\]])/g, "$1");
  s = s.replace(/(\(|\[)[ \t]+/g, "$1");

  // 5) 단락 사이는 최대 두 개의 개행으로 유지
  s = s.replace(/\n{3,}/g, "\n\n");

  // 6) 앞뒤 공백 제거 및 NFC 정규화
  s = s.trim();
  try {
    s = s.normalize("NFC");
  } catch {
    // ignore
  }

  return s;
}

/**
 * 일반 텍스트 정규화(EN 등). 개행 통일 및 비표준 공백 제거 정도만 수행한다.
 */
export function normalizePlainText(raw: string): string {
  if (!raw) return "";

  let s = scrubSpecialCharacters(raw)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  try {
    s = s.normalize("NFC");
  } catch {
    // ignore
  }

  return s;
}

/** HWP 정규화가 유효할 가능성이 있는지 판단하는 작은 휴리스틱. */
export function looksLikeHwpExtract(
  text: string,
  filename?: string | null,
): boolean {
  if (!text) return false;

  const trimmed = text.trim();
  if (!trimmed) return false;

  if (filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".hwp") || lower.endsWith(".hwpx")) {
      return true;
    }
    if (!lower.endsWith(".hwp") && !lower.endsWith(".hwpx")) {
      return false;
    }
  }

  const hasHangul = /[가-힣]/.test(trimmed);
  if (!hasHangul) return false;

  const singleBreaks = (trimmed.match(/\n(?!\n)/g) ?? []).length;
  const paragraphBreaks = (trimmed.match(/\n\n+/g) ?? []).length;

  return singleBreaks > Math.max(2, paragraphBreaks * 2);
}
