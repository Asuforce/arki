export type Tier = 1 | 2 | 3;

/** 管理画面が API の PATCH に流してよい本文は、人が決める `{tier}` とロック解除だけ。バッチ用の書き方は通さない。 */
export function tierPatchBody(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (keys.length !== 1) return null;
  const body = input as Record<string, unknown>;
  if (keys[0] === "tier" && (body.tier === 1 || body.tier === 2 || body.tier === 3)) return JSON.stringify({ tier: body.tier });
  if (keys[0] === "tier_locked" && body.tier_locked === false) return JSON.stringify({ tier_locked: false });
  return null;
}
