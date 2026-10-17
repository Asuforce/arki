export interface PostSummary {
  id: number;
  slug: string;
  title: string;
  excerpt: string;
  status: "draft" | "published";
  published_at: string;
  categories: string[];
  thumbnail: string | null;
}

export interface Post extends Omit<PostSummary, "thumbnail"> {
  content: string;
  updated_at: string;
  legacy_url: string | null;
}

export interface PostList {
  posts: PostSummary[];
  page: number;
  limit: number;
  total: number;
}

export interface CategoryCount {
  name: string;
  count: number;
}

const apiBase = (): string => (import.meta.env.PUBLIC_API_URL ?? "http://localhost:8787").replace(/\/$/, "");

async function get<T>(path: string): Promise<T | null> {
  const res = await fetch(apiBase() + path);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
  return (await res.json()) as T;
}

export async function listPosts(opts: { page?: number; limit?: number; category?: string; month?: string; q?: string } = {}): Promise<PostList> {
  const q = new URLSearchParams({ page: String(opts.page ?? 1), limit: String(opts.limit ?? 20) });
  if (opts.category) q.set("category", opts.category);
  if (opts.month) q.set("month", opts.month);
  if (opts.q) q.set("q", opts.q);
  const list = await get<PostList>(`/api/posts?${q}`);
  if (!list) throw new Error("API /api/posts not found");
  return list;
}

/** slug は `2019/11/23/031344` のように `/` を含むので、1 段ずつエンコードする。 */
export function getPost(slug: string): Promise<Post | null> {
  const path = slug.split("/").map(encodeURIComponent).join("/");
  return get<Post>(`/api/posts/by-slug/${path}`);
}

export async function listCategories(): Promise<CategoryCount[]> {
  const res = await get<{ categories: CategoryCount[] }>("/api/categories");
  return res?.categories ?? [];
}

export interface MonthCount {
  /** JST の `YYYY-MM` */
  month: string;
  count: number;
}

export async function listArchive(): Promise<MonthCount[]> {
  const res = await get<{ months: MonthCount[] }>("/api/archive");
  return res?.months ?? [];
}
