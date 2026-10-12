import { fromJstInput } from "./jst";

export interface Snapshot {
  title: string;
  content: string;
  categories: string[];
  date: string;
}

export interface SaveFields {
  slug?: { enabled: boolean; value: string; current: string };
  status: "draft" | "published";
  updatedAt: string | null;
}

/** 保存する本文。日付と slug は、今と違うときだけ入れる。読んだ値の送り返しは、手で決めたことにならない。 */
export function buildPayload(now: Snapshot, saved: Snapshot, fields: SaveFields): Record<string, unknown> | { error: string } {
  const payload: Record<string, unknown> = {
    title: now.title,
    content: now.content,
    categories: now.categories,
    status: fields.status,
  };
  if (!now.date && saved.date) return { error: "公開日時は空にできません" };
  if (now.date && now.date !== saved.date) {
    const iso = fromJstInput(now.date);
    if (!iso) return { error: "公開日時を読めません" };
    payload.published_at = iso;
  }
  if (fields.slug?.enabled && fields.slug.value !== fields.slug.current) payload.slug = fields.slug.value;
  if (fields.updatedAt) payload.expected_updated_at = fields.updatedAt;
  return payload;
}

export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return a.title === b.title && a.content === b.content && a.date === b.date && a.categories.join("\n") === b.categories.join("\n");
}
