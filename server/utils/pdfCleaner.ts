import {
  DEFAULT_JOINER,
  JoinerOptions,
  normalizeEol,
  reBlank,
  reAllWhitespace,
  quoteBalance,
  joinStrategy,
  reHeading,
  reListBullet,
} from "./lineJoiner";

export interface PdfCleanOptions extends JoinerOptions {
  preserveParagraphBreaks?: boolean;
  collapseWhitespace?: boolean;
}

const DEFAULTS: Required<PdfCleanOptions> = {
  preserveParagraphBreaks: true,
  collapseWhitespace: true,
  ...DEFAULT_JOINER,
};

export function cleanPdfText(
  rawText: string,
  options: PdfCleanOptions = {},
): string {
  const opt = { ...DEFAULTS, ...options };
  const text = normalizeEol(rawText ?? "");
  const lines = text.split("\n");

  const out: string[] = [];
  let buffer = "";
  let quoteDepth = 0;

  const paragraphSeparator = opt.preserveParagraphBreaks ? "\n\n" : "\n";

  const pushParagraph = () => {
    out.push(paragraphSeparator);
  };

  for (let i = 0; i < lines.length; i++) {
    const current = lines[i] ?? "";
    const balance = quoteBalance(current);
    const inQuoteBlock = opt.respectQuoteBlocks && quoteDepth > 0;

    if (reBlank.test(current)) {
      if (buffer.trim()) {
        out.push(buffer.trimEnd());
        buffer = "";
      }
      let j = i + 1;
      while (j < lines.length && reBlank.test(lines[j] ?? "")) j++;
      i = j - 1;
      pushParagraph();
      quoteDepth = Math.max(0, quoteDepth + balance);
      continue;
    }

    if (!buffer) {
      buffer = current.trim();
    } else {
      const how = joinStrategy(buffer, current, opt, inQuoteBlock, true);
      if (how === "nospace") {
        buffer = buffer.replace(/-\s*$/, "") + current.trimStart();
      } else if (how === "space") {
        buffer = `${buffer} ${current.trim()}`;
      } else {
        out.push(buffer.trimEnd());
        out.push(opt.preserveParagraphBreaks ? "\n" : " ");
        buffer = current.trim();
      }
    }

    const next = lines[i + 1]?.trim() ?? "";
    if (next && (reHeading.test(next) || reListBullet.test(next))) {
      out.push(buffer.trimEnd());
      out.push(opt.preserveParagraphBreaks ? "\n" : " ");
      buffer = "";
    }

    quoteDepth = Math.max(0, quoteDepth + balance);
  }

  if (buffer.trim()) {
    out.push(buffer.trimEnd());
  }

  let result = out
    .join("")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (opt.collapseWhitespace) {
    result = result
      .split("\n")
      .map((line) => line.replace(reAllWhitespace, " ").trim())
      .join(opt.preserveParagraphBreaks ? "\n" : " ");
  }

  return result;
}

export default cleanPdfText;
