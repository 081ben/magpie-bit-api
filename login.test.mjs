// The community sign-in, asked as two questions one after the other: the
// session cookie (the site keeps it in the HttpOnly cookie bitapi_session), then
// the chat key. The login page is opened as the first question comes up, since
// the key only exists to copy after the login. The cookie is checked against
// /api/me as it is pasted, and the answers are kept with the key.
import { afterEach, expect, test } from "bun:test"
import { BaipiaoPlugin, _internal } from "./index.mjs"
import { fakeBaipiao, startRoutes } from "./fake.mjs"

let f
let opened = []

// every test starts with the opener stubbed, so a sign-in here opens no browser
_internal.setLoginPageOpener((url) => {
  opened.push(url)
  return true
})

afterEach(() => {
  f?.close()
  f = null
  opened = []
  _internal.setLoginPageOpener((url) => {
    opened.push(url)
    return true
  })
})

const plugin = async () => BaipiaoPlugin()

const method = (hooks) => hooks.auth.methods.find((m) => m.type === "oauth")

const KEY = "sk-mine-9"
const JWT = "jwt-pasted"

// a stand-in portal that knows the token the tests paste
const portal = () => {
  f = fakeBaipiao()
  startRoutes(f)
  return f
}

// signIn runs the questions the way magpie does: ask with the answers so far,
// until none is left, then authorize.
const signIn = async (hooks, answers = (q) => (q.key.startsWith("cookie") ? `bitapi_session=${JWT}` : KEY)) => {
  const m = method(hooks)
  const inputs = {}
  for (let i = 0; i < 10; i++) {
    const q = await m.ask(inputs)
    if (!q) return m.authorize()
    inputs[q.key] = answers(q)
  }
  throw new Error("the sign-in kept asking")
}

test("the first question is the session cookie, and it opens the login page", async () => {
  portal()
  const hooks = await plugin()
  const q = await method(hooks).ask({})
  expect(q.key).toBe("cookie1")
  expect(q.type).toBe("text")
  expect(q.placeholder).toBe("bitapi_session=…")
  expect(q.message).toMatch(/bitapi_session/)
  expect(q.messages.zh).toMatch(/bitapi_session/)
  expect(opened).toEqual(["https://ai.baipiao.co/portal#/login"])
})

test("the page is opened once per attempt, not for every question", async () => {
  portal()
  const hooks = await plugin()
  const m = method(hooks)
  const first = await m.ask({})
  await m.ask({ [first.key]: `bitapi_session=${JWT}` })
  expect(opened.length).toBe(1)
})

test("the second question is the chat key, typed unseen", async () => {
  portal()
  const hooks = await plugin()
  const m = method(hooks)
  const first = await m.ask({})
  const second = await m.ask({ [first.key]: `bitapi_session=${JWT}` })
  expect(second.key).toBe("key1")
  expect(second.type).toBe("password")
  expect(second.message).toMatch(/chat key/)
  expect(second.messages.zh).toMatch(/聊天密钥/)
})

test("the cookie is checked as it is pasted, not after the key", async () => {
  portal()
  const hooks = await plugin()
  const m = method(hooks)
  const first = await m.ask({})
  await m.ask({ [first.key]: `bitapi_session=${JWT}` })
  expect(f.seen.filter((r) => r.path === "/api/me").length).toBe(1)
  // magpie asks the same question again on its way to authorize: not checked twice
  await m.ask({ [first.key]: `bitapi_session=${JWT}` })
  expect(f.seen.filter((r) => r.path === "/api/me").length).toBe(1)
})

test("a cookie the site turns away is asked again with why", async () => {
  portal()
  const hooks = await plugin()
  const m = method(hooks)
  const first = await m.ask({})
  const again = await m.ask({ [first.key]: "bitapi_session=jwt-wrong" })
  expect(again.key).toBe(first.key)
  expect(again.message).toMatch(/expired|refused/)
})

test("a paste with no session cookie is asked again with why", async () => {
  portal()
  const hooks = await plugin()
  const first = await method(hooks).ask({})
  const again = await method(hooks).ask({ [first.key]: "bitapi_csrf=abc; bitapi_theme=dark" })
  expect(again.key).toBe(first.key)
  expect(again.message).toMatch(/bitapi_session/)
  expect(f.seen.length).toBe(0)
})

test("a key that isn't one is asked again with why", async () => {
  portal()
  const hooks = await plugin()
  const m = method(hooks)
  const first = await m.ask({})
  const again = await m.ask({ [first.key]: `bitapi_session=${JWT}`, key1: "nope" })
  expect(again.key).toBe("key1")
  expect(again.message).toMatch(/chat key/)
})

test("once both are answered no question is left", async () => {
  portal()
  const hooks = await plugin()
  const m = method(hooks)
  const first = await m.ask({})
  const second = await m.ask({ [first.key]: `bitapi_session=${JWT}` })
  const done = await m.ask({ [first.key]: `bitapi_session=${JWT}`, [second.key]: KEY })
  expect(done).toBeNull()
})

test("a retry asks again from the cookie, with questions of its own", async () => {
  portal()
  const hooks = await plugin()
  const m = method(hooks)
  const first = await m.ask({})
  await m.ask({ [first.key]: `bitapi_session=${JWT}` })
  // magpie starts the sign-in over with nothing answered
  const again = await m.ask({})
  expect(again.key).not.toBe(first.key)
  expect(opened.length).toBe(2)
})

test("the answers finish the sign-in, which magpie doesn't open again", async () => {
  portal()
  const hooks = await plugin()
  const out = await signIn(hooks)
  expect(out.type).toBeUndefined()
  expect(out.url).toBe("https://ai.baipiao.co/portal#/login")
  expect(out.opened).toBe(true)
  expect(out.method).toBe("auto")
  const kept = await out.callback()
  expect(kept.type).toBe("success")
  expect(kept.access).toBe(JWT)
  expect(kept.apiKey).toBe(KEY)
  // magpie's Auth union needs refresh and expires on an OAuth account
  expect(kept.refresh).toBe("none")
  expect(kept.expires).toBe(0)
  // named by the site's own id for the account, so a second account of the
  // site's sits beside the first rather than replacing it
  expect(kept.accountId).toBe("ann@example.com")
})

test("the account's own key list is never read", async () => {
  portal()
  const hooks = await plugin()
  const out = await signIn(hooks)
  await out.callback()
  expect(f.seen.map((r) => r.path)).not.toContain("/api/keys")
})

test("a page that didn't open is not claimed as opened", async () => {
  portal()
  _internal.setLoginPageOpener(() => false)
  const hooks = await plugin()
  const m = method(hooks)
  const first = await m.ask({})
  expect(first.message).toMatch(/https:\/\/ai\.baipiao\.co\/portal#\/login/)
  const second = await m.ask({ [first.key]: `bitapi_session=${JWT}` })
  await m.ask({ [first.key]: `bitapi_session=${JWT}`, [second.key]: KEY })
  const out = await m.authorize()
  expect(out.opened).toBe(false)
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

test("a wrong or stale token is a failed sign-in, named as such", async () => {
  portal()
  const out = await _internal.signInCommunity({ cookie: "bitapi_session=jwt-wrong", key: KEY, opened: true })
  expect(out.type).toBe("failed")
  expect(out.error).toMatch(/refused/)
})

test("a cookie without the session fails before the portal is asked", async () => {
  f = fakeBaipiao()
  const out = await _internal.signInCommunity({ cookie: "bitapi_csrf=abc; bitapi_theme=dark", key: KEY, opened: true })
  expect(out.type).toBe("failed")
  expect(out.error).toMatch(/bitapi_session/)
  expect(f.seen.length).toBe(0)
})

test("a key that isn't one fails, saying where it comes from", async () => {
  f = fakeBaipiao()
  const out = await _internal.signInCommunity({ cookie: `bitapi_session=${JWT}`, key: "nope", opened: true })
  expect(out.type).toBe("failed")
  expect(out.error).toMatch(/chat key/)
  expect(f.seen.length).toBe(0)
})

test("authorize without the answers says to sign in again", async () => {
  const hooks = await plugin()
  const out = await method(hooks).authorize()
  expect(out.type).toBe("failed")
  expect(out.error).toMatch(/sign in again/)
})
