// The usage read and the models list: /api/overview with the session token,
// /v1/models with the key; a 401 marks the sign-in lapsed (bitapi has no
// refresh token, so the account says to sign in again).
import { afterEach, expect, test } from "bun:test"
import { BaipiaoPlugin, _internal } from "./index.mjs"
import { account, fakeBaipiao, json, models, overview } from "./fake.mjs"

let f
afterEach(() => f?.close())

const plugin = async (client = {}) => BaipiaoPlugin({ client })

const routes = (f, { access = "jwt-1", key = "sk-test-1" } = {}) => {
  f.route("GET /api/overview", (r) =>
    r.headers.get("authorization") === `Bearer ${access}` ? json(overview) : json({ detail: "invalid or expired token" }, 401),
  )
  f.route("GET /v1/models", (r) => {
    const auth = (r.headers.get("authorization") ?? "").replace("Bearer ", "")
    if (!auth || auth === key) return json(models)
    return json({ detail: "Unauthorized" }, 401)
  })
}

test("usage reads the balance and today's spend off /api/overview", async () => {
  f = fakeBaipiao()
  routes(f)
  const hooks = await plugin()
  const out = await hooks.auth.usage(async () => account())
  expect(out.plan).toBe("bit-api")
  expect(out.balance).toBe("$12.35")
  expect(out.signIn).toBe("kept")
  expect(out.windows).toEqual([{ name: "Today", display: "$0.12 · 7 requests" }])
  expect(out.checkin).toEqual({ date: "2026-10-15", checked_in: false })
})

test("a lapsed token reads as expired; nothing renews it for you", async () => {
  f = fakeBaipiao()
  f.route("GET /api/overview", () => json({ detail: "invalid or expired token" }, 401))
  const hooks = await plugin()
  const out = await hooks.auth.usage(async () => account({ access: "gone" }))
  expect(out.error).toMatch(/sign in again/)
  expect(out.signIn).toBe("expired")
  // bitapi signs no refresh token: no second ask, no saved renewal
  expect(f.seen.filter((r) => r.path === "/api/overview").length).toBe(1)
})

test("usage without a signed-in account says so", async () => {
  f = fakeBaipiao()
  const hooks = await plugin()
  await expect(hooks.auth.usage(async () => null)).rejects.toThrow(/not signed in/)
  await expect(hooks.auth.usage(async () => ({ type: "api", key: "sk-x" }))).rejects.toThrow(/not signed in/)
  expect(f.seen.length).toBe(0)
})

test("models come from /v1/models with the account's key; blank ids are dropped", async () => {
  f = fakeBaipiao()
  routes(f)
  const hooks = await plugin()
  const list = await hooks.provider.models({ models: {} }, { auth: account() })
  expect(Object.keys(list)).toEqual(["DeepSeek-V4-Flash", "claude-sonnet-5"])
  expect(list["DeepSeek-V4-Flash"].provider).toEqual({
    npm: "@ai-sdk/openai-compatible",
    api: f.origin + "/v1",
  })
})

test("a models read that fails keeps the provider's own table", async () => {
  f = fakeBaipiao()
  f.route("GET /v1/models", () => json({ detail: "Unauthorized" }, 401))
  const hooks = await plugin()
  const keep = { "glm-5": { id: "glm-5" } }
  const list = await hooks.provider.models({ models: keep }, { auth: account({ apiKey: "sk-nope" }) })
  expect(list).toBe(keep)
})

test("a token-only account asks /v1/models with its session token", async () => {
  f = fakeBaipiao()
  f.route("GET /v1/models", (r) =>
    r.headers.get("authorization") === "Bearer jwt-1" ? json(models) : json({ detail: "Unauthorized" }, 401),
  )
  const hooks = await plugin()
  const list = await hooks.provider.models({ models: {} }, { auth: { type: "oauth", access: "jwt-1" } })
  expect(Object.keys(list)).toEqual(["DeepSeek-V4-Flash", "claude-sonnet-5"])
})

test("the loader hands the gateway the base URL and the key the account has", async () => {
  f = fakeBaipiao()
  const hooks = await plugin()
  const keyed = await hooks.auth.loader(async () => ({ type: "api", key: "sk-mine" }))
  expect(keyed).toEqual({ baseURL: f.origin + "/v1", apiKey: "sk-mine" })
  const own = await hooks.auth.loader(async () => account({ apiKey: "sk-stored" }))
  expect(own.apiKey).toBe("sk-stored")
  // an account signed in with its token alone picks its first active key up
  // (list is masked; the plain key comes from the reveal page)
  f.route("GET /api/keys", (r) =>
    r.headers.get("authorization") === "Bearer jwt-1"
      ? json({ keys: [{ id: 2, key_masked: "sk-***st", status: "active" }, { id: 3, key_masked: "sk-***nd", status: "active" }] })
      : json({ detail: "x" }, 401),
  )
  f.route("GET /api/keys/2/reveal", () => json({ id: 2, key: "sk-first-plain" }))
  const picked = await hooks.auth.loader(async () => account({ apiKey: undefined }))
  expect(picked.apiKey).toBe("sk-first-plain")
})

test("the loader answers nothing for an unsigned-in auth", async () => {
  const hooks = await plugin()
  expect(await hooks.auth.loader(async () => null)).toEqual({})
})

test("config declares the provider for models.dev's sake", async () => {
  const hooks = await plugin()
  const cfg = {}
  await hooks.config(cfg)
  expect(cfg.provider.baipiao).toMatchObject({
    name: "bit-api",
    npm: "@ai-sdk/openai-compatible",
    api: "https://ai.baipiao.co/v1",
  })
})
