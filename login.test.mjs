// The community sign-in: the plugin opens the authorize URL, the user pastes
// the session token the site's callback page stored; the token is checked
// against /api/me and the account's first chat key comes with it.
import { afterEach, expect, test } from "bun:test"
import { BaipiaoPlugin, _internal } from "./index.mjs"
import { account, fakeBaipiao, json, startRoutes } from "./fake.mjs"

let f
afterEach(() => f?.close())

const plugin = async (client = {}) => BaipiaoPlugin({ client })

const method = (hooks) => hooks.auth.methods.find((m) => m.type === "oauth")

test("authorize opens the portal's own login page, asking nothing itself", async () => {
  f = fakeBaipiao()
  const hooks = await plugin()
  const out = await method(hooks).authorize()
  expect(out.method).toBe("code")
  expect(out.url).toBe("https://ai.baipiao.co/portal#/login")
  // the flow cookie belongs to the user's browser; the plugin asks nothing
  expect(f.seen.length).toBe(0)
})

test("a pasted token is checked against /api/me and stored with the first key", async () => {
  f = fakeBaipiao()
  startRoutes(f)
  // the keys list only names masked keys; the plain one comes from reveal
  f.route("GET /api/keys", (r) =>
    r.headers.get("authorization") === "Bearer jwt-pasted"
      ? json({ keys: [{ id: 7, name: "chat", key_masked: "sk-***st", status: "active" }] })
      : json({ detail: "x" }, 401),
  )
  f.route("GET /api/keys/7/reveal", (r) =>
    r.headers.get("authorization") === "Bearer jwt-pasted" ? json({ id: 7, key: "sk-plain-7" }) : json({ detail: "x" }, 401),
  )
  const hooks = await plugin()
  const out = await (await method(hooks).authorize()).callback("jwt-pasted")
  expect(out.type).toBe("success")
  expect(out.access).toBe("jwt-pasted")
  expect(out.apiKey).toBe("sk-plain-7")
  // magpie's Auth union needs refresh and expires on an OAuth account
  expect(out.refresh).toBe("none")
  expect(out.expires).toBe(0)
  // the reveal page was asked for the first active key's id
  expect(f.seen.map((r) => r.path)).toContain("/api/keys/7/reveal")
})

test("a wrong or stale token is a failed sign-in, named as such", async () => {
  f = fakeBaipiao()
  startRoutes(f)
  const hooks = await plugin()
  const out = await (await method(hooks).authorize()).callback("jwt-wrong")
  expect(out.type).toBe("failed")
  expect(out.error).toMatch(/refused/)
})

test("an empty paste fails before the portal is asked", async () => {
  f = fakeBaipiao()
  const hooks = await plugin()
  const out = await (await method(hooks).authorize()).callback("  ")
  expect(out.type).toBe("failed")
  // only the authorize page's start ask went out; no token check
  expect(f.seen.filter((r) => r.path === "/api/me").length).toBe(0)
})

test("an account without a key yet still signs in", async () => {
  f = fakeBaipiao()
  startRoutes(f)
  f.route("GET /api/keys", (r) =>
    r.headers.get("authorization") === "Bearer jwt-pasted" ? json({ keys: [] }) : json({ detail: "x" }, 401),
  )
  const hooks = await plugin()
  const out = await (await method(hooks).authorize()).callback("jwt-pasted")
  expect(out.type).toBe("success")
  expect(out.apiKey).toBeUndefined()
  // the loader answers the base URL alone; no key, no fabricated one
  const loaded = await hooks.auth.loader(async () => ({ type: "oauth", access: "jwt-pasted" }))
  expect(loaded.baseURL).toBe(f.origin + "/v1")
  expect(loaded.apiKey).toBe("")
})

// (the old "start page refused" case is gone: the plugin never asks for a
// start page itself; the browser does, on the portal's own page)
