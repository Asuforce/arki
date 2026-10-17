import type { PostList, PostSummary } from "./api";

/** 管理用のトークンつきの応答だけが持つ。公開側の型には載せない。 */
export interface TierState {
  tier: 1 | 2 | 3 | null;
  tier_confidence: number | null;
  tier_locked: boolean;
}

export type AdminPostSummary = PostSummary & TierState;

export interface AdminPostList extends Omit<PostList, "posts"> {
  posts: AdminPostSummary[];
}

export interface AdminPost extends TierState {
  id: number;
  slug: string;
  title: string;
  content: string;
  excerpt: string;
  status: "draft" | "published";
  published_at: string;
  created_at: string;
  updated_at: string;
  legacy_url: string | null;
  slug_fixed: boolean;
  date_unset: boolean;
  categories: string[];
}

export interface AdminApiConfig {
  base: string;
  token: string;
  fetch?: typeof fetch;
}

export interface AdminApi {
  send(method: string, path: string, body?: BodyInit | null, headers?: Record<string, string>): Promise<Response>;
  listPosts(opts: { page?: number; status?: string; tier?: string; q?: string }): Promise<AdminPostList>;
  getPost(id: number): Promise<AdminPost | null>;
  categoryNames(): Promise<string[]>;
}

/** トークンを載せた GET は下書きまで返す。公開ページが使う `api.ts` に混ぜない。 */
export function createAdminApi(config: AdminApiConfig): AdminApi {
  const doFetch = config.fetch ?? fetch;
  const base = config.base.replace(/\/$/, "");

  const send: AdminApi["send"] = (method, path, body, headers) =>
    doFetch(base + path, {
      method,
      body: body ?? null,
      headers: { Authorization: `Bearer ${config.token}`, ...headers },
    });

  async function json<T>(path: string): Promise<T | null> {
    const res = await send("GET", path);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
    return (await res.json()) as T;
  }

  return {
    send,
    async listPosts({ page = 1, status = "", tier = "", q = "" }) {
      const query = new URLSearchParams({ page: String(page), limit: "20" });
      if (status) query.set("status", status);
      if (tier) query.set("tier", tier);
      if (q) query.set("q", q);
      const list = await json<AdminPostList>(`/api/posts?${query}`);
      if (!list) throw new Error("API /api/posts not found");
      return list;
    },
    getPost: (id) => json<AdminPost>(`/api/posts/${id}`),
    async categoryNames() {
      const res = await json<{ categories: { name: string }[] }>("/api/categories");
      return (res?.categories ?? []).map((c) => c.name);
    },
  };
}
