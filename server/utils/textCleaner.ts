import {
  DEFAULT_JOINER,
  JoinerOptions,
  normalizeEol,
  reBlank,
  reAllWhitespace,
  quoteBalance,
  joinStrategy,
} from "./lineJoiner";

export interface TxtCleanOptions extends JoinerOptions {
  preserveParagraphBreaks?: boolean;
  collapseWhitespace?: boolean;
  preserveSingleLineBreaks?: boolean;
}

const DEFAULTS: Required<TxtCleanOptions> = {
  preserveParagraphBreaks: true,
  collapseWhitespace: true,
  preserveSingleLineBreaks: false,
  ...DEFAULT_JOINER,
};

export function cleanTxtHardWrap(
  rawText: string,
  options: TxtCleanOptions = {},
): string {
  const opt = { ...DEFAULTS, ...options };
  const text = normalizeEol(rawText ?? "");
  const lines = text.split("\n");

  const out: string[] = [];
  let buffer = "";
  let quoteDepth = 0;

  const paragraphSeparator = opt.preserveParagraphBreaks ? "\n\n" : "\n";

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
      out.push(paragraphSeparator);
      quoteDepth = Math.max(0, quoteDepth + balance);
      continue;
    }

    if (!buffer) {
      buffer = current.trim();
    } else if (opt.preserveSingleLineBreaks) {
      out.push(buffer.trimEnd());
      out.push("\n");
      buffer = current.trim();
    } else {
      const how = joinStrategy(buffer, current, opt, inQuoteBlock, false);
      if (how === "space") {
        buffer = `${buffer} ${current.trim()}`;
      } else if (how === "nospace") {
        buffer = buffer + current.trimStart();
      } else {
        out.push(buffer.trimEnd());
        out.push(opt.preserveParagraphBreaks ? "\n" : " ");
        buffer = current.trim();
      }
    }

    quoteDepth = Math.max(0, quoteDepth + balance);
  }

  if (buffer.trim()) {
    out.push(buffer.trimEnd());
  }

  let result = out
    .join("")
    .replace(/[ \t]+\n/g, "\n")
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

export default cleanTxtHardWrap;
