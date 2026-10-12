import cloudflare from "@astrojs/cloudflare";
import { defineConfig, envField } from "astro/config";

export default defineConfig({
  output: "server",
  // KV（セッション）と Images のバインディングは使わない。Cloudflare のリソースは infra 側で持つ
  session: false,
  adapter: cloudflare({ imageService: "passthrough" }),
  // 記事の URL は /entry/YYYY/MM/DD/HHMMSS（はてなと同じ）
  trailingSlash: "never",
  // 管理画面の secret。ビルドには要らないので optional にし、未設定なら /admin は閉じる
  env: {
    schema: {
      ADMIN_TOKEN: envField.string({ context: "server", access: "secret", optional: true }),
      ACCESS_AUD: envField.string({ context: "server", access: "secret", optional: true }),
      ACCESS_TEAM_DOMAIN: envField.string({ context: "server", access: "secret", optional: true }),
      ADMIN_EMAIL: envField.string({ context: "server", access: "secret", optional: true }),
      ADMIN_DEV_BYPASS: envField.string({ context: "server", access: "secret", optional: true }),
    },
  },
});
