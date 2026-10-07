// Captions from word timings: cues that break at speaker-free boundaries a
// reader expects (sentence punctuation, a pause, the line budget), never
// inside a word. Thai is the point: it writes no spaces, its vowels and tone
// marks take no width, and a caption cut by character count would split a
// word. The word spans say where words end, so every break lands on one.

export interface WordSpan {
  text: string;
  start: number;
  end: number;
  /** Whether the source text had whitespace before this word. Undefined means unknown, and script decides. */
  spaceBefore?: boolean;
}

export interface Cue {
  start: number;
  end: number;
  lines: string[];
}

export interface CueOptions {
  /** Characters per line, Thai marks above and below not counted. */
  lineChars: number;
  maxLines: number;
  /** A gap between words at least this long starts a new cue. */
  pauseSeconds: number;
  /** A cue never runs longer than this. */
  maxSeconds: number;
  /** A cue stays on screen at least this long, short of the next cue. */
  minSeconds: number;
}

export const DEFAULT_CUE_OPTIONS: CueOptions = { lineChars: 60, maxLines: 2, pauseSeconds: 0.7, maxSeconds: 6, minSeconds: 1 };

const THAI = /[\u0E00-\u0E7F]/;
const THAI_MARKS = /[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/g;
const SENTENCE_END = /[.!?。！？]["')\]]?$/;

/** Visible width: every character except the Thai marks that sit above or below a consonant. */
export function visibleWidth(text: string): number {
  return text.replace(THAI_MARKS, "").length;
}

/** The source's own spacing when known; otherwise Thai words join without a space and anything else gets one. */
function joiner(previous: string, next: WordSpan): string {
  if (next.spaceBefore !== undefined) return next.spaceBefore ? " " : "";
  const a = previous.at(-1) ?? "";
  const b = next.text[0] ?? "";
  return THAI.test(a) && THAI.test(b) ? "" : " ";
}

/**
 * Mark each span with whether the source text had whitespace before it, by
 * walking the source in order. Thai writers put spaces at phrase boundaries
 * and captions should keep them. A span that cannot be found nearby leaves
 * its flag undefined, so the script rule decides for it.
 */
export function markSpacing(spans: WordSpan[], source: string): WordSpan[] {
  let cursor = 0;
  return spans.map((span) => {
    const text = span.text.trim();
    if (!text) return span;
    const at = source.indexOf(text, cursor);
    if (at === -1 || at - cursor > 40) return span;
    const spaceBefore = /\s/.test(source.slice(cursor, at));
    cursor = at + text.length;
    return { ...span, spaceBefore };
  });
}

function render(words: WordSpan[]): string {
  let out = "";
  for (const word of words) out = out ? out + joiner(out, word) + word.text : word.text;
  return out;
}

/**
 * Lay words out as lines within the budget, breaking only between words.
 * When a line overflows, the break moves back to the last phrase boundary
 * (a space in the source) on that line, as long as the line keeps at least
 * half its budget: a Thai line then ends where the writer paused.
 */
function layout(words: WordSpan[], lineChars: number): string[] {
  const lines: string[] = [];
  let current: WordSpan[] = [];
  for (const word of words) {
    if (current.length > 0 && visibleWidth(render([...current, word])) > lineChars) {
      let cut = current.length;
      for (let k = current.length - 1; k >= 1; k--) {
        if (joiner(render(current.slice(0, k)), current[k] as WordSpan) === " " && visibleWidth(render(current.slice(0, k))) * 2 >= lineChars) {
          cut = k;
          break;
        }
      }
      lines.push(render(current.slice(0, cut)));
      current = [...current.slice(cut), word];
    } else {
      current.push(word);
    }
  }
  if (current.length > 0) lines.push(render(current));
  return lines;
}

export function buildCues(spans: WordSpan[], options: Partial<CueOptions> = {}): Cue[] {
  const o = { ...DEFAULT_CUE_OPTIONS, ...options };
  const cues: Cue[] = [];
  let words: WordSpan[] = [];

  const flush = (): void => {
    if (words.length === 0) return;
    const first = words[0] as WordSpan;
    const last = words[words.length - 1] as WordSpan;
    cues.push({ start: first.start, end: last.end, lines: layout(words, o.lineChars) });
    words = [];
  };

  for (const span of spans) {
    const text = span.text.trim();
    if (!text) continue;
    const word = { ...span, text };
    if (words.length > 0) {
      const previous = words[words.length - 1] as WordSpan;
      const first = words[0] as WordSpan;
      const gap = word.start - previous.end;
      const tooLong = word.end - first.start > o.maxSeconds;
      const sentenceDone = SENTENCE_END.test(previous.text);
      const fits = layout([...words, word], o.lineChars).length <= o.maxLines;
      if (gap >= o.pauseSeconds || sentenceDone || tooLong || !fits) flush();
    }
    words.push(word);
  }
  flush();

  // Keep every cue on screen at least minSeconds, without running into the next one.
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i] as Cue;
    const next = cues[i + 1];
    const wanted = cue.start + o.minSeconds;
    if (cue.end < wanted) cue.end = next ? Math.min(wanted, next.start) : wanted;
  }
  return cues;
}

function timecode(seconds: number, separator: "," | "."): string {
  const total = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const ms = total % 1000;
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${separator}${pad(ms, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${timecode(c.start, ",")} --> ${timecode(c.end, ",")}\n${c.lines.join("\n")}\n`).join("\n");
}

export function toVtt(cues: Cue[]): string {
  return "WEBVTT\n\n" + cues.map((c) => `${timecode(c.start, ".")} --> ${timecode(c.end, ".")}\n${c.lines.join("\n")}\n`).join("\n");
}

export interface Pause {
  start: number;
  end: number;
  seconds: number;
}

/** Gaps between consecutive words at least `threshold` seconds long: the dead air an editor cuts. */
export function findPauses(spans: WordSpan[], threshold: number): Pause[] {
  const pauses: Pause[] = [];
  for (let i = 1; i < spans.length; i++) {
    const gap = (spans[i] as WordSpan).start - (spans[i - 1] as WordSpan).end;
    if (gap >= threshold) pauses.push({ start: (spans[i - 1] as WordSpan).end, end: (spans[i] as WordSpan).start, seconds: gap });
  }
  return pauses;
}
