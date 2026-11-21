// Handling of text written by the pull request author. It is data, never instructions.

// C0 controls except tab (\u0009) and newline (\u000a), DEL, C1 controls, the soft
// hyphen, the Arabic letter mark, the Mongolian vowel separator, zero-width and
// direction marks, line and paragraph separators, embeddings and overrides,
// invisible operators, isolates, the byte order mark, and the tag characters.
const INVISIBLE =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;

const INLINE_LIMIT = 300;

export function stripControl(text: string): { text: string; removed: number } {
  const normalised = text.replaceAll('\r\n', '\n');
  let removed = 0;
  const cleaned = normalised.replace(INVISIBLE, () => {
    removed += 1;
    return '';
  });
  return { text: cleaned, removed };
}

// True when the text holds a character that stripControl would remove; a CRLF line ending is not one.
export function hasHidden(text: string): boolean {
  return stripControl(text).removed > 0;
}

// Single-line form of untrusted text: control characters stripped, each newline
// and tab turned into one space, cut to INLINE_LIMIT characters.
export function inlineText(text: string): string {
  const { text: stripped } = stripControl(text);
  return stripped.replace(/[\n\t]/g, ' ').slice(0, INLINE_LIMIT);
}

// Untrusted text shown whole up to `limit` characters: stripped, then cut without splitting a surrogate pair.
export function cutText(text: string, limit: number): string {
  const clean = stripControl(text).text;
  if (clean.length <= limit) return clean;
  let end = limit;
  const last = clean.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${clean.slice(0, end)} [cut]`;
}

// Deletion can join the pieces around an occurrence into a new one, so repeat
// until none is left. Each pass shortens the text, so this terminates.
function deleteToken(text: string, token: string): string {
  let result = text;
  while (result.includes(token)) {
    result = result.replaceAll(token, '');
  }
  return result;
}

export function wrapData(label: string, text: string, token: string): string {
  if (token === '') {
    throw new Error('empty marker token');
  }
  const safeLabel = deleteToken(inlineText(label), token);
  const body = deleteToken(text, token);
  return `<<<data ${token} ${safeLabel}>>>\n${body}\n<<<end ${token}>>>`;
}
