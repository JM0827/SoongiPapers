import cleanPdfText, { PdfCleanOptions } from "./pdfCleaner";
import cleanTxtHardWrap, { TxtCleanOptions } from "./textCleaner";

export type SourceKind = "pdf" | "txt" | "auto";

export interface CleanTextOptions
  extends Partial<PdfCleanOptions & TxtCleanOptions> {
  source?: SourceKind;
}

function guessSource(raw: string): SourceKind {
  const normalized = raw.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const nonBlank = lines.filter((line) => line.trim().length > 0);
  const avgLen =
    nonBlank.reduce((sum, line) => sum + line.trim().length, 0) /
    Math.max(1, nonBlank.length);
  const hyphenBreaks = (normalized.match(/[A-Za-z]-\s*\n[A-Za-z]/g) || [])
    .length;

  if (hyphenBreaks >= 2 || avgLen < 45) {
    return "pdf";
  }
  return "txt";
}

export function cleanText(raw: string, options: CleanTextOptions = {}): string {
  const { source, ...rest } = options;
  const src = source ?? "auto";
  const kind = src === "auto" ? guessSource(raw) : src;

  if (kind === "pdf") {
    return cleanPdfText(raw, rest);
  }
  const txtOptions: TxtCleanOptions = { ...rest };
  if (txtOptions.preserveSingleLineBreaks === undefined) {
    txtOptions.preserveSingleLineBreaks = true;
  }
  return cleanTxtHardWrap(raw, txtOptions);
}

export default cleanText;
