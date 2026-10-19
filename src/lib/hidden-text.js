/** Detect repeated invisible-character insertion, not ordinary whitespace. Returns
 * compact counts only; the original text is never changed or stored here.
 * Joiners in normal emoji sequences do not contribute to the suspicious count.
 * Requiring insertions between Han/Latin letters or digits avoids treating normal
 * joining behavior in Arabic/Indic scripts as spam by itself.
 */
export function hiddenTextEvidence(text) {
  const source = String(text || "").slice(0, 14000);
  let hidden = 0, insertions = 0;
  for (const match of source.matchAll(/[\u00ad\u200b-\u200d\u2060\ufeff]+/gu)) {
    const before = source.slice(Math.max(0, match.index - 8), match.index), after = source.slice(match.index + match[0].length, match.index + match[0].length + 4);
    const emojiJoin = /^\u200d$/u.test(match[0]) && /\p{Extended_Pictographic}[\uFE0E\uFE0F\p{Emoji_Modifier}]*$/u.test(before) && /^\p{Extended_Pictographic}/u.test(after);
    if (emojiJoin) continue;
    hidden += match[0].length;
    if (/[\p{Script=Han}\p{Script=Latin}\p{Number}]$/u.test(before) && /^[\p{Script=Han}\p{Script=Latin}\p{Number}]/u.test(after)) insertions++;
  }
  const ratio = hidden / Math.max(1, Array.from(source).length);
  return { matched: hidden >= 10 && ratio >= .2 && insertions >= 4, hidden, ratio, insertions };
}
