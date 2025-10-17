export function normalizeNewlines(input: string | null | undefined): string {
  return (input ?? "").replace(/\r\n?/g, "\n");
}

export function alignParagraphs(
  leftRaw: string,
  rightRaw: string,
): { left: string; right: string } {
  const left = normalizeNewlines(leftRaw);
  let right = normalizeNewlines(rightRaw).replace(/\n{3,}/g, "\n\n");

  const leftHasParagraphBreaks = /\n{2,}/.test(left);
  if (!leftHasParagraphBreaks) {
    right = right.replace(/\n{2,}/g, "\n");
  }

  return { left, right };
}
