/**
 * Shorten a heading to a few words.
 *
 * The reader's header is one line, and the text in it was never written to be a heading: an older
 * passage's topic is a whole plot — "The coffee machine at work stops working" — which pushes the
 * position counter and the band off the row. Three words is enough to recognise a passage you have
 * read, and the full topic stays in the tooltip.
 *
 * Pure and deliberately naive about language: it splits on whitespace, so it works the same for
 * German compounds as for English phrases, and it never cuts inside a word.
 */
export function truncateWords(text: string, max = 3): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const words = trimmed.split(/\s+/);
  if (words.length <= max) return trimmed;
  return `${words.slice(0, max).join(" ")}…`;
}
