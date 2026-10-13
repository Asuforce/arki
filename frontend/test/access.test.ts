import assert from "node:assert/strict";
import { test } from "node:test";
import { AccessUnavailableError, accessCookies, verifyAccessCookie, verifyAccessJwt } from "../src/lib/access.ts";

const config = { teamDomain: "team.example.com", aud: "aud-1", email: "me@example.com" };
const b64url = (data: ArrayBuffer | string): string =>
  Buffer.from(typeof data === "string" ? data : new Uint8Array(data)).toString("base64url");

async function setup() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
  const loadKeys = async () => [jwk as JsonWebKey & { kid: string }];
  const sign = async (claims: object, header: object = { alg: "RS256", kid: "k1" }, key = pair.privateKey) => {
    const h = b64url(JSON.stringify(header));
    const p = b64url(JSON.stringify(claims));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(sig)}`;
  };
  return { loadKeys, sign };
}

const now = Date.UTC(2026, 9, 12);
const valid = { aud: ["aud-1"], iss: "https://team.example.com", exp: now / 1000 + 600, email: "me@example.com" };

test("正しい JWT ならメールを返す", async () => {
  const { loadKeys, sign } = await setup();
  assert.equal(await verifyAccessJwt(await sign(valid), config, loadKeys, now), "me@example.com");
});

test("JWT が無い、形が違うときは通さない", async () => {
  const { loadKeys } = await setup();
  assert.equal(await verifyAccessJwt(null, config, loadKeys, now), null);
  assert.equal(await verifyAccessJwt("a.b", config, loadKeys, now), null);
  assert.equal(await verifyAccessJwt("a.b.c", config, loadKeys, now), null);
});

test("aud、iss、期限が合わなければ通さない", async () => {
  const { loadKeys, sign } = await setup();
  assert.equal(await verifyAccessJwt(await sign({ ...valid, aud: ["other"] }), config, loadKeys, now), null);
  assert.equal(await verifyAccessJwt(await sign({ ...valid, iss: "https://evil.example.com" }), config, loadKeys, now), null);
  assert.equal(await verifyAccessJwt(await sign({ ...valid, exp: now / 1000 - 1 }), config, loadKeys, now), null);
  assert.equal(await verifyAccessJwt(await sign({ ...valid, exp: undefined }), config, loadKeys, now), null);
});

test("別の鍵で署名した JWT は通さない", async () => {
  const { loadKeys } = await setup();
  const other = await setup();
  assert.equal(await verifyAccessJwt(await other.sign(valid), config, loadKeys, now), null);
});

test("alg が RS256 でない、kid が合わない JWT は通さない", async () => {
  const { loadKeys, sign } = await setup();
  assert.equal(await verifyAccessJwt(await sign(valid, { alg: "none", kid: "k1" }), config, loadKeys, now), null);
  assert.equal(await verifyAccessJwt(await sign(valid, { alg: "RS256", kid: "other" }), config, loadKeys, now), null);
});

test("Service Token 由来（email なし）は通さない", async () => {
  const { loadKeys, sign } = await setup();
  assert.equal(await verifyAccessJwt(await sign({ ...valid, email: undefined, common_name: "svc" }), config, loadKeys, now), null);
});

test("許可したメール以外は、署名が正しくても通さない", async () => {
  const { loadKeys, sign } = await setup();
  assert.equal(await verifyAccessJwt(await sign({ ...valid, email: "other@example.com" }), config, loadKeys, now), null);
  assert.equal(await verifyAccessJwt(await sign({ ...valid, email: "ME@Example.com" }), config, loadKeys, now), "ME@Example.com");
});

test("未知の kid は鍵を取り直してから判断する", async () => {
  const { loadKeys, sign } = await setup();
  const calls: (boolean | undefined)[] = [];
  const rotated = async (_domain: string, refresh?: boolean) => {
    calls.push(refresh);
    return refresh ? loadKeys() : [];
  };
  assert.equal(await verifyAccessJwt(await sign(valid), config, rotated, now), "me@example.com");
  assert.deepEqual(calls, [undefined, true]);
});

test("鍵を取れないときは 401 にせず例外にする", async () => {
  const { sign } = await setup();
  const down = async (): Promise<never> => {
    throw new AccessUnavailableError("certs down");
  };
  await assert.rejects(verifyAccessJwt(await sign(valid), config, down, now), AccessUnavailableError);
});

test("Cookie ヘッダーから Access の JWT を全部取る", () => {
  assert.deepEqual(accessCookies("a=1; CF_Authorization=x.y.z; b=2"), ["x.y.z"]);
  assert.deepEqual(accessCookies("CF_Authorization=abc=="), ["abc=="]);
  assert.deepEqual(accessCookies("CF_Authorization=one; CF_Authorization=two"), ["one", "two"]);
  assert.deepEqual(accessCookies("a=1; CF_Authorization="), []);
  assert.deepEqual(accessCookies(null), []);
});

test("クッキーの JWT でメールを返す。同名が並んでも、通るものが 1 つあればよい", async () => {
  const { loadKeys, sign } = await setup();
  const good = await sign(valid);
  assert.equal(await verifyAccessCookie(`CF_Authorization=${good}`, config, loadKeys, now), "me@example.com");
  assert.equal(await verifyAccessCookie(`CF_Authorization=aaa.bbb.ccc; CF_Authorization=${good}`, config, loadKeys, now), "me@example.com");
  assert.equal(await verifyAccessCookie(`CF_Authorization=${await sign({ ...valid, aud: ["other"] })}`, config, loadKeys, now), null);
  assert.equal(await verifyAccessCookie(null, config, loadKeys, now), null);
});
