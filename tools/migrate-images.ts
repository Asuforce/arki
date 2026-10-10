/**
 * 本文に残っているはてなの画像を取得し、R2 に置いて、置き換え表（image-map.json）を作る。
 *
 *   npx tsx migrate-images.ts <backup-dir> --base-url https://img.example.com [--bucket arki-images] [--upload] [--old-host <host>]
 *
 * --upload を付けなければ、一覧の表示と取得だけを行う（tools/out/images/ に保存）。
 * 画像は R2 の `legacy/fotolife/...`（はてなと同じパス）に置く。作った image-map.json を
 * `import-hatena.ts --image-map` に渡して取り込み直す。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import matter from "gray-matter";
import { collectHatenaImages, convertBody } from "./hatena.ts";

const OUT_DIR = "out/images";
const DELAY_MS = 500; // はてなへの負荷を抑える

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith(".md")) yield path;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function download(url: string, dest: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      return;
    }
    if (res.status === 404) throw new Error(`404 ${url}`);
    await sleep(1000 * attempt);
  }
  throw new Error(`failed after retries: ${url}`);
}

const CONTENT_TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png", gif: "image/gif" };

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opt = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const dir = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
  const baseUrl = opt("--base-url")?.replace(/\/$/, "");
  if (!dir || !baseUrl) throw new Error("usage: migrate-images.ts <backup-dir> --base-url <url> [--bucket <name>] [--upload]");
  const bucket = opt("--bucket") ?? "arki-images";
  const upload = argv.includes("--upload");

  const urls = new Set<string>();
  for (const file of walk(join(dir, "entry"))) {
    const { content } = convertBody(matter(readFileSync(file, "utf8")).content, { oldHost: opt("--old-host") });
    for (const u of collectHatenaImages(content)) urls.add(u);
  }
  console.log(`${urls.size} images`);

  const map: Record<string, string> = {};
  const failed: string[] = [];
  for (const url of [...urls].sort()) {
    const key = "legacy/fotolife/" + new URL(url).pathname.replace(/^\/images\/fotolife\//, "");
    const dest = join(OUT_DIR, key);
    try {
      if (!existsSync(dest)) {
        await download(url, dest);
        await sleep(DELAY_MS);
      }
      if (upload) {
        const ext = key.split(".").pop() ?? "";
        execFileSync(
          "npx",
          ["wrangler", "r2", "object", "put", `${bucket}/${key}`, "--file", dest, "--content-type", CONTENT_TYPES[ext] ?? "application/octet-stream", "--remote"],
          { stdio: "ignore" },
        );
      }
      map[url] = `${baseUrl}/${key}`;
    } catch (e) {
      failed.push(`${url} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  writeFileSync("image-map.json", JSON.stringify(map, null, 2) + "\n");
  console.log(`image-map.json: ${Object.keys(map).length} entries${upload ? " (uploaded)" : " (downloaded only)"}`);
  if (failed.length) console.warn(`failed: ${failed.length}\n  ${failed.slice(0, 20).join("\n  ")}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
