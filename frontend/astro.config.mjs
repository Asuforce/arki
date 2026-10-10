import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "server",
  // KV（セッション）と Images のバインディングは使わない。Cloudflare のリソースは infra 側で持つ
  session: false,
  adapter: cloudflare({ imageService: "passthrough" }),
  // 記事の URL は /entry/YYYY/MM/DD/HHMMSS（はてなと同じ）
  trailingSlash: "never",
});
