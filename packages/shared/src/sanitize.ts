// Unicode sanitization for untrusted text.
// Default posture: strip anything that has no legitimate place in plain prose
// (tag chars, bidi overrides, supplementary variation selectors, zero-width
// chars outside known emoji sequences, soft hyphen). Flag — don't strip —
// mixed-script text, since false positives there break legitimate multilingual
// content.

export type StrippedCategory =
  | "tag_character"
  | "bidi_override"
  | "zero_width"
  | "soft_hyphen"
  | "variation_selector"
  | "homoglyph";

export interface StrippedSpan {
  offset: number;
  length: number;
  category: StrippedCategory;
  codePoints: number[];
  context?: string;
}

export interface SanitizeResult {
  clean: string;
  stripped: StrippedSpan[];
  flags: StrippedCategory[];
}

const BIDI_CHARS = new Set<number>([
  0x202a, // LRE
  0x202b, // RLE
  0x202c, // PDF
  0x202d, // LRO
  0x202e, // RLO
  0x2066, // LRI
  0x2067, // RLI
  0x2068, // FSI
  0x2069, // PDI
  0x200e, // LRM
  0x200f, // RLM
]);

const TAG_LOW = 0xe0000;
const TAG_HIGH = 0xe007f;

const VS_SUPPLEMENT_LOW = 0xe0100;
const VS_SUPPLEMENT_HIGH = 0xe01ef;

const ZWJ = 0x200d;
const ZWNJ = 0x200c;
const ZWS = 0x200b;
const ZWNBSP = 0xfeff;
const SOFT_HYPHEN = 0x00ad;
const VS15 = 0xfe0e;
const VS16 = 0xfe0f;

export function sanitizeUntrusted(text: string): SanitizeResult {
  const normalized = text.normalize("NFKC");

  const stripped: StrippedSpan[] = [];
  const cleanChars: string[] = [];

  let i = 0;
  while (i < normalized.length) {
    const cp = normalized.codePointAt(i);
    if (cp === undefined) {
      i += 1;
      continue;
    }
    const charLen = cp > 0xffff ? 2 : 1;
    const offset = i;

    if (cp >= TAG_LOW && cp <= TAG_HIGH) {
      stripped.push({ offset, length: charLen, category: "tag_character", codePoints: [cp] });
      i += charLen;
      continue;
    }

    if (cp >= VS_SUPPLEMENT_LOW && cp <= VS_SUPPLEMENT_HIGH) {
      stripped.push({ offset, length: charLen, category: "variation_selector", codePoints: [cp] });
      i += charLen;
      continue;
    }

    if (BIDI_CHARS.has(cp)) {
      stripped.push({ offset, length: charLen, category: "bidi_override", codePoints: [cp] });
      i += charLen;
      continue;
    }

    if (cp === SOFT_HYPHEN) {
      stripped.push({ offset, length: charLen, category: "soft_hyphen", codePoints: [cp] });
      i += charLen;
      continue;
    }

    if (cp === ZWJ) {
      const before = lastCleanCodePoint(cleanChars);
      const after = peekCodePoint(normalized, i + charLen);
      if (isEmojiBase(before) && isEmojiBase(after)) {
        cleanChars.push(String.fromCodePoint(cp));
      } else {
        stripped.push({ offset, length: charLen, category: "zero_width", codePoints: [cp] });
      }
      i += charLen;
      continue;
    }

    if (cp === ZWNJ || cp === ZWS || cp === ZWNBSP) {
      stripped.push({ offset, length: charLen, category: "zero_width", codePoints: [cp] });
      i += charLen;
      continue;
    }

    if (cp === VS15 || cp === VS16) {
      const before = lastCleanCodePoint(cleanChars);
      if (before !== undefined && isEmojiBase(before)) {
        cleanChars.push(String.fromCodePoint(cp));
      } else {
        stripped.push({
          offset,
          length: charLen,
          category: "variation_selector",
          codePoints: [cp],
        });
      }
      i += charLen;
      continue;
    }

    cleanChars.push(String.fromCodePoint(cp));
    i += charLen;
  }

  const clean = cleanChars.join("");

  const mixed = detectMixedScript(clean);
  if (mixed.detected) {
    stripped.push({
      offset: 0,
      length: clean.length,
      category: "homoglyph",
      codePoints: [],
      context: `mixed scripts: ${mixed.scripts.join(", ")}`,
    });
  }

  const flags = Array.from(new Set(stripped.map((s) => s.category)));
  return { clean, stripped, flags };
}

export function sanitizedText(text: string): string {
  return sanitizeUntrusted(text).clean;
}

function isEmojiBase(cp: number | undefined): boolean {
  if (cp === undefined) return false;
  // Emoji ZWJ chains chain on the ZWJ itself.
  if (cp === ZWJ) return true;
  // Common emoji and pictographic blocks. This is a coarse-but-safe filter:
  // false negatives mean we strip a legitimate ZWJ inside a tasteful emoji
  // sequence (acceptable for v0.3 — kickoff says err on the side of stripping).
  if (cp >= 0x1f000 && cp <= 0x1faff) return true;
  if (cp >= 0x2600 && cp <= 0x27bf) return true;
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return true;
  // Variation selectors that may anchor onto a base emoji.
  if (cp === VS16 || cp === VS15) return true;
  return false;
}

function lastCleanCodePoint(chars: string[]): number | undefined {
  if (chars.length === 0) return undefined;
  const last = chars[chars.length - 1];
  return last?.codePointAt(0);
}

function peekCodePoint(s: string, i: number): number | undefined {
  if (i >= s.length) return undefined;
  return s.codePointAt(i);
}

function detectMixedScript(text: string): { detected: boolean; scripts: string[] } {
  let hasLatin = false;
  let hasCyrillic = false;
  let hasGreek = false;
  let hasArmenian = false;
  let hasHebrew = false;

  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (
      (cp >= 0x0041 && cp <= 0x005a) ||
      (cp >= 0x0061 && cp <= 0x007a) ||
      (cp >= 0x00c0 && cp <= 0x024f)
    ) {
      hasLatin = true;
    } else if (cp >= 0x0400 && cp <= 0x052f) {
      hasCyrillic = true;
    } else if (cp >= 0x0370 && cp <= 0x03ff) {
      hasGreek = true;
    } else if (cp >= 0x0530 && cp <= 0x058f) {
      hasArmenian = true;
    } else if (cp >= 0x0590 && cp <= 0x05ff) {
      hasHebrew = true;
    }
  }

  const scripts: string[] = [];
  if (hasLatin) scripts.push("latin");
  if (hasCyrillic) scripts.push("cyrillic");
  if (hasGreek) scripts.push("greek");
  if (hasArmenian) scripts.push("armenian");
  if (hasHebrew) scripts.push("hebrew");

  return { detected: scripts.length > 1, scripts };
}
