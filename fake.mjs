// A fake of the bit-api portal for the tests: one local server standing in
// for ai.baipiao.co, which globalThis.__BAIPIAO_HOST__ points the plugin at.
// route(method, path) answers a request; seen lists what came.
import { _internal } from "./index.mjs"

export function fakeBaipiao() {
  const routes = new Map()
  const seen = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      const text = await req.text()
      const r = { method: req.method, path: url.pathname, headers: req.headers, text }
      if (text) try { r.json = JSON.parse(text) } catch {}
      seen.push(r)
      const h = routes.get(req.method + " " + url.pathname)
      if (!h) return new Response("no route " + req.method + " " + url.pathname, { status: 404 })
      return h(r)
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  globalThis.__BAIPIAO_HOST__ = origin
  return {
    origin,
    seen,
    route: (key, h) => routes.set(key, h),
    close() {
      server.stop(true)
      delete globalThis.__BAIPIAO_HOST__
    },
  }
}

export const json = (v, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } })

export const account = (over = {}) => ({
  type: "oauth",
  access: "jwt-1",
  apiKey: "sk-test-1",
  ...over,
})

export const overview = {
  balance: 12.3456,
  total_spent: 87.65,
  group: "default",
  policy: "balance",
  today: { requests: 7, input_tokens: 100, output_tokens: 200, cost: 0.1234 },
  checkin: { date: "2026-10-15", checked_in: false, reward: null, range: { min: 0.01, max: 0.1 } },
}

export const models = {
  object: "list",
  data: [
    { id: "DeepSeek-V4-Flash", object: "model", created: 1, owned_by: "ds" },
    { id: "claude-sonnet-5", object: "model", created: 1, owned_by: "ant" },
    { id: "", object: "model", created: 1, owned_by: "x" }, // dropped: no id
  ],
}

// startRoutes answers /api/me for the pasted-token check (the plugin itself
// never asks the portal for an authorize URL; the user's browser does).
export const startRoutes = (f) => {
  f.route("GET /api/me", (r) =>
    r.headers.get("authorization") === "Bearer jwt-pasted"
      ? json({ id: 1, username: "ann", email: "ann@example.com" })
      : json({ detail: "invalid or expired token" }, 401),
  )
}
