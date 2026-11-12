// The community sign-in: magpie asks for the chat key first (the method's
// prompts), then the plugin opens the authorize URL and the user pastes the
// session the site keeps in its HttpOnly cookie (bitapi_session). The token is
// checked against /api/me and the key the user named is kept beside it.
import { afterEach, expect, test } from "bun:test"
import { BaipiaoPlugin, _internal } from "./index.mjs"
import { fakeBaipiao, startRoutes } from "./fake.mjs"

let f
afterEach(() => f?.close())

const plugin = async () => BaipiaoPlugin()

const method = (hooks) => hooks.auth.methods.find((m) => m.type === "oauth")

const KEY = "sk-mine-9"

test("authorize opens the portal's own login page, asking nothing itself", async () => {
  f = fakeBaipiao()
  const hooks = await plugin()
  const out = await method(hooks).authorize({ apiKey: KEY })
  expect(out.method).toBe("code")
  expect(out.url).toBe("https://ai.baipiao.co/portal#/login")
  // the flow cookie belongs to the user's browser; the plugin asks nothing
  expect(f.seen.length).toBe(0)
})

test("the chat key is asked before the browser, and must be a key", async () => {
  const m = method(await plugin())
  expect(m.prompts).toHaveLength(1)
  const [p] = m.prompts
  expect(p.key).toBe("apiKey")
  expect(p.type).toBe("password")
  // magpie checks the answer with the question's validate before it moves on
  expect(p.validate(KEY)).toBeUndefined()
  expect(p.validate("")).toMatch(/sk-/)
  expect(p.validate("not-a-key")).toMatch(/sk-/)
})

test("the instructions point at the session cookie, not localStorage", async () => {
  const out = await (await method(await plugin())).authorize({ apiKey: KEY })
  expect(out.instructions).toMatch(/bitapi_session/)
  expect(out.instructions).not.toMatch(/localStorage\.bitapi_token/)
})

test("a sign-in with no chat key refuses to start, saying why", async () => {
  f = fakeBaipiao()
  const hooks = await plugin()
  const out = await method(hooks).authorize({})
  expect(out.type).toBe("failed")
  expect(out.error).toMatch(/chat key/)
  // nothing is opened and the portal is not asked
  expect(out.url).toBeUndefined()
  expect(f.seen.length).toBe(0)
})

test("the pasted cookie string yields the session token in either form", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"
  expect(_internal.sessionToken(jwt)).toBe(jwt)
  expect(_internal.sessionToken(`  ${jwt}\n`)).toBe(jwt)
  expect(_internal.sessionToken(`bitapi_session=${jwt}`)).toBe(jwt)
  expect(_internal.sessionToken(`bitapi_csrf=abc; bitapi_session=${jwt}; bitapi_theme=dark`)).toBe(jwt)
  expect(_internal.sessionToken(`Cookie: bitapi_session=${jwt}; bitapi_csrf=abc`)).toBe(jwt)
  // a Cookie header without the session cookie names no token
  expect(_internal.sessionToken("bitapi_csrf=abc")).toBe("")
  expect(_internal.sessionToken("")).toBe("")
})

test("a pasted cookie header is checked and stored with the key the user named", async () => {
  f = fakeBaipiao()
  startRoutes(f)
  const hooks = await plugin()
  const out = await (await method(hooks).authorize({ apiKey: KEY })).callback(
    "bitapi_csrf=abc; bitapi_session=jwt-pasted",
  )
  expect(out.type).toBe("success")
  expect(out.access).toBe("jwt-pasted")
  expect(out.apiKey).toBe(KEY)
  expect(f.seen.find((r) => r.path === "/api/me").headers.get("authorization")).toBe("Bearer jwt-pasted")
})

test("the sign-in keeps the named key, and asks the account for no other", async () => {
  f = fakeBaipiao()
  startRoutes(f)
  const hooks = await plugin()
  const out = await (await method(hooks).authorize({ apiKey: KEY })).callback("jwt-pasted")
  expect(out.type).toBe("success")
  expect(out.apiKey).toBe(KEY)
  // magpie's Auth union needs refresh and expires on an OAuth account
  expect(out.refresh).toBe("none")
  expect(out.expires).toBe(0)
  // the account's own key list is never read: no reveal, no guessing
  expect(f.seen.map((r) => r.path)).not.toContain("/api/keys")
})

test("a wrong or stale token is a failed sign-in, named as such", async () => {
  f = fakeBaipiao()
  startRoutes(f)
  const hooks = await plugin()
  const out = await (await method(hooks).authorize({ apiKey: KEY })).callback("jwt-wrong")
  expect(out.type).toBe("failed")
  expect(out.error).toMatch(/refused/)
})

test("an empty paste fails before the portal is asked", async () => {
  f = fakeBaipiao()
  const hooks = await plugin()
  const out = await (await method(hooks).authorize({ apiKey: KEY })).callback("  ")
  expect(out.type).toBe("failed")
  // only the authorize page's start ask went out; no token check
  expect(f.seen.filter((r) => r.path === "/api/me").length).toBe(0)
})

test("a cookie string without the session cookie fails before the portal is asked", async () => {
  f = fakeBaipiao()
  const hooks = await plugin()
  const out = await (await method(hooks).authorize({ apiKey: KEY })).callback("bitapi_csrf=abc; bitapi_theme=dark")
  expect(out.type).toBe("failed")
  expect(out.error).toMatch(/bitapi_session/)
  expect(f.seen.length).toBe(0)
})
