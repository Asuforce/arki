import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createAdminApi } from "../src/lib/admin-api.ts";

function recorder() {
  const calls: { url: string; headers: Headers }[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ posts: [], page: 1, limit: 20, total: 0, categories: [] }), { status: 200 });
  }) as typeof fetch;
  return { calls, fakeFetch };
}

test("管理用のクライアントは Bearer を付ける", async () => {
  const { calls, fakeFetch } = recorder();
  const api = createAdminApi({ base: "https://api.example.com/", token: "secret", fetch: fakeFetch });
  await api.listPosts({ status: "draft", q: "日記" });
  assert.equal(calls[0].headers.get("Authorization"), "Bearer secret");
  assert.match(calls[0].url, /^https:\/\/api\.example\.com\/api\/posts\?/);
  assert.match(calls[0].url, /status=draft/);
});

test("公開側のコードは管理用のトークンに触れない（送ると下書きが公開側に出る）", () => {
  const root = new URL("../src/", import.meta.url).pathname;
  const publicFiles = [...walk(root)].filter((f) => {
    const rel = f.slice(root.length);
    return !rel.startsWith("pages/admin/") && !/(^|\/)admin[-A-Z]|Admin[A-Z]|editor|middleware|(^|\/)access\.ts$/i.test(rel);
  });
  assert.ok(publicFiles.some((f) => f.endsWith("lib/api.ts")), "公開側の api.ts を検査している");
  for (const file of publicFiles) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /ADMIN_TOKEN|Authorization|admin-api|admin-config|admin-http/, file);
  }
});

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}
