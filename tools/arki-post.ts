/**
 * Markdown ファイルを arki の API に投稿（または更新）する。
 *
 *   ARKI_API_URL=https://... ARKI_ADMIN_TOKEN=... npx tsx arki-post.ts post.md
 *
 * 先頭の front matter:
 *   title: 題名            （必須）
 *   date: 2026-10-10T09:00:00+09:00   （省略すると今）
 *   categories: [日記, ごはん]
 *   status: published      （省略すると draft）
 *   slug: 2026/10/10/090000 （省略すると date から作る）
 */
import { readFileSync } from "node:fs";
import matter from "gray-matter";
import { slugFromDate, toUtcIso } from "./text.ts";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error("usage: arki-post.ts <file.md>");
  const base = env("ARKI_API_URL").replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${env("ARKI_ADMIN_TOKEN")}`, "Content-Type": "application/json" };

  const { data, content } = matter(readFileSync(file, "utf8"));
  if (!data.title) throw new Error("front matter needs a title");
  const date = data.date ? new Date(data.date as string | Date) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date: ${String(data.date)}`);

  const slug = typeof data.slug === "string" ? data.slug : slugFromDate(date);
  const body = {
    title: String(data.title),
    content: content.trim(),
    status: data.status === "published" ? "published" : "draft",
    published_at: toUtcIso(date),
    slug,
    categories: Array.isArray(data.categories) ? data.categories.map(String) : [],
  };

  // 同じ slug の記事があれば更新、なければ新規
  const found = await fetch(`${base}/api/posts/by-slug/${slug}`, { headers });
  let res: Response;
  if (found.ok) {
    const { id } = (await found.json()) as { id: number };
    res = await fetch(`${base}/api/posts/${id}`, { method: "PUT", headers, body: JSON.stringify(body) });
  } else if (found.status === 404) {
    res = await fetch(`${base}/api/posts`, { method: "POST", headers, body: JSON.stringify(body) });
  } else {
    throw new Error(`lookup failed: ${found.status} ${await found.text()}`);
  }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  console.log(`${found.ok ? "updated" : "created"}: /entry/${slug} (${body.status})`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
