/**
 * Split long text into TTS-friendly segments. Segments stay well under the
 * API's 5000-character request limit; a smaller target keeps time-to-first-
 * audio low and lets the queue synthesize ahead while playing.
 */
export function chunkText(text: string, target = 1500): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let buf = "";
  for (const paragraph of paragraphs) {
    const pieces = paragraph.length > target ? splitLong(paragraph, target) : [paragraph];
    for (const piece of pieces) {
      if (buf.length === 0) {
        buf = piece;
      } else if (buf.length + piece.length + 2 <= target) {
        buf += "\n\n" + piece;
      } else {
        chunks.push(buf);
        buf = piece;
      }
    }
  }
  if (buf.length > 0) chunks.push(buf);
  return chunks;
}

/**
 * Break a single overlong paragraph at sentence enders, then at spaces
 * (Thai separates phrases with spaces), then hard-cut as a last resort.
 */
function splitLong(text: string, target: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > target) {
    const window = rest.slice(0, target);
    let cut = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
      window.lastIndexOf("\n"),
    );
    if (cut < target / 2) {
      const space = window.lastIndexOf(" ");
      cut = space >= target / 4 ? space : -1;
    }
    const end = cut > 0 ? cut + 1 : target;
    const piece = rest.slice(0, end).trim();
    if (piece.length > 0) out.push(piece);
    rest = rest.slice(end).trim();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}
