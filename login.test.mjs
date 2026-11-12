// The community sign-in: the plugin opens the authorize URL, the user signs in
// in the browser, then pastes the session the site keeps in its HttpOnly cookie
// (bitapi_session) with the chat key on a second line. The token is checked
// against /api/me and the key is kept beside it.
import { afterEach, expect, test } from "bun:test"
import { BaipiaoPlugin, _internal } from "./index.mjs"
import { fakeBaipiao, startRoutes } from "./fake.mjs"

let f
afterEach(() => f?.close())

const plugin = async () => BaipiaoPlugin()

const method = (hooks) => hooks.auth.methods.find((m) => m.type === "oauth")

const KEY = "sk-mine-9"
const JWT = "jwt-pasted"

test("authorize opens the portal's own login page, asking nothing itself", async () => {
  f = fakeBaipiao()
  const hooks = await plugin()
  const out = await method(hooks).authorize()
  expect(out.method).toBe("code")
  expect(out.url).toBe("https://ai.baipiao.co/portal#/login")
  // the flow cookie belongs to the user's browser; the plugin asks nothing
  expect(f.seen.length).toBe(0)
})

test("nothing is asked before the browser: the key comes after the login", async () => {
  const m = method(await plugin())
  expect(m.prompts).toBeUndefined()
})

test("the instructions point at the session cookie and the second line", async () => {
  const out = await (await method(await plugin())).authorize()
  expect(out.instructions).toMatch(/bitapi_session/)
  expect(out.instructions).not.toMatch(/localStorage\.bitapi_token/)
  expect(out.instructions).toMatch(/second line/)
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

test("the paste splits into a session token and a key", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"
  expect(_internal.signInPaste(`bitapi_session=${jwt}\n${KEY}`)).toEqual({ token: jwt, key: KEY })
  expect(_internal.signInPaste(`${jwt}\n  ${KEY}  `)).toEqual({ token: jwt, key: KEY })
  // a key on the cookie's own line is picked out of it
  expect(_internal.signInPaste(`bitapi_session=${jwt}; ${KEY}`)).toEqual({ token: jwt, key: KEY })
  expect(_internal.signInPaste(`bitapi_session=${jwt}`)).toEqual({ token: jwt, key: "" })
  expect(_internal.signInPaste(KEY)).toEqual({ token: "", key: KEY })
})

test("a paste with both is checked and kept with the key", async () => {
  f = fakeBaipiao()
  startRoutes(f)
  const hooks = await plugin()
  const out = await (await method(hooks).authorize()).callback(
    `bitapi_csrf=abc; bitapi_session=${JWT}\n${KEY}`,
  )
  expect(out.type).toBe("success")
  expect(out.access).toBe(JWT)
  expect(out.apiKey).toBe(KEY)
  expect(f.seen.find((r) => r.path === "/api/me").headers.get("authorization")).toBe(`Bearer ${JWT}`)
})

test("the sign-in keeps the named key, and asks the account for no other", async () => {
  f = fakeBaipiao()
  startRoutes(f)
  const hooks = await plugin()
  const out = await (await method(hooks).authorize()).callback(`bitapi_session=${JWT}\n${KEY}`)
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
  const out = await (await method(hooks).authorize()).callback(`bitapi_session=jwt-wrong\n${KEY}`)
  expect(out.type).toBe("failed")
  expect(out.error).toMatch(/refused/)
})

test("a paste without the key fails, saying where it goes", async () => {
  f = fakeBaipiao()
  startRoutes(f)
  const hooks = await plugin()
  const out = await (await method(hooks).authorize()).callback(`bitapi_session=${JWT}`)
  expect(out.type).toBe("failed")
  expect(out.error).toMatch(/chat key/)
  expect(out.error).toMatch(/second line/)
  // the token was never checked: nothing is saved without the key
  expect(f.seen.filter((r) => r.path === "/api/me").length).toBe(0)
})

test("a key pasted without a session fails and says why", async () => {
  f = fakeBaipiao()
  const hooks = await plugin()
  const out = await (await method(hooks).authorize()).callback(KEY)
  expect(out.type).toBe("failed")
  expect(out.error).toMatch(/bitapi_session/)
  expect(f.seen.length).toBe(0)
})

test("an empty paste fails before the portal is asked", async () => {
  f = fakeBaipiao()
  const hooks = await plugin()
  const out = await (await method(hooks).authorize()).callback("  ")
  expect(out.type).toBe("failed")
  expect(f.seen.filter((r) => r.path === "/api/me").length).toBe(0)
})

test("a cookie string without the session cookie fails before the portal is asked", async () => {
  f = fakeBaipiao()
  const hooks = await plugin()
  const out = await (await method(hooks).authorize()).callback(`bitapi_csrf=abc; bitapi_theme=dark\n${KEY}`)
  expect(out.type).toBe("failed")
  expect(out.error).toMatch(/bitapi_session/)
  expect(f.seen.length).toBe(0)
})
