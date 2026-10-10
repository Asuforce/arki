import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "server",
  adapter: cloudflare(),
  // 記事の URL は /entry/YYYY/MM/DD/HHMMSS（はてなと同じ）
  trailingSlash: "never",
});
