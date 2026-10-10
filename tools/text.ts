/** 一覧用の抜粋。backend/src/util.rs の make_excerpt と同じ規則にしてある。 */
export function makeExcerpt(markdown: string, maxChars = 120): string {
  let text = "";
  let inTag = false;
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("<!--") ||
      trimmed.startsWith("```") ||
      (trimmed.startsWith("<a href=") && trimmed.includes("link-card"))
    ) {
      continue;
    }
    const chars = [...trimmed];
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (c === "<") inTag = true;
      else if (c === ">" && inTag) inTag = false;
      else if (inTag) continue;
      else if (c === "!" && chars[i + 1] === "[") {
        while (i < chars.length && chars[i] !== ")") i++;
      } else if (c === "[") {
        let label = "";
        i++;
        while (i < chars.length && chars[i] !== "]") label += chars[i++];
        if (chars[i + 1] === "(") {
          i++;
          while (i < chars.length && chars[i] !== ")") i++;
        }
        text += label;
      } else if ("#*`>|".includes(c)) continue;
      else text += c;
    }
    text += " ";
  }
  return [...text.split(/\s+/).filter(Boolean).join(" ")].slice(0, maxChars).join("");
}

/** UTC の ISO 8601（ミリ秒なし）。 */
export function toUtcIso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 公開日時（UTC）から JST の `YYYY/MM/DD/HHMMSS` を作る。backend の slug_from_published_at と同じ。 */
export function slugFromDate(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 3600 * 1000).toISOString();
  return `${jst.slice(0, 4)}/${jst.slice(5, 7)}/${jst.slice(8, 10)}/${jst.slice(11, 13)}${jst.slice(14, 16)}${jst.slice(17, 19)}`;
}

export function sqlString(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}
