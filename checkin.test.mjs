// The daily check-in: POST /api/checkin with the session token; claimed when
// the reward was credited now, done when the day was already in, a 401 a
// lapsed sign-in (bitapi has no refresh token, so it says to sign in again).
import { afterEach, expect, test } from "bun:test"
import { BaipiaoPlugin } from "./index.mjs"
import { account, fakeBaipiao, json } from "./fake.mjs"

let f
afterEach(() => f?.close())

const plugin = async (client = {}) => BaipiaoPlugin({ client })

const checkinRoute = (f, v, status = 200, access = "jwt-1") => {
  f.route("POST /api/checkin", (r) =>
    r.headers.get("authorization") === `Bearer ${access}`
      ? json(v, status)
      : json({ detail: "invalid or expired token" }, 401),
  )
}

test("a first check-in of the day claims the reward", async () => {
  f = fakeBaipiao()
  checkinRoute(f, {
    ok: true, date: "2026-10-15", checked_in: true, claimed: true,
    reward: 0.0521, balance: 12.3977, range: { min: 0.01, max: 0.1 },
  })
  const hooks = await plugin()
  const out = await hooks.auth.checkin(async () => account())
  expect(out.outcome).toBe("claimed")
  expect(out.credit).toBe("$0.05")
  expect(out.message).toMatch(/\+ \$0\.05 · \$12\.40/)
})

test("a second check-in the same day is done", async () => {
  f = fakeBaipiao()
  checkinRoute(f, {
    ok: true, date: "2026-10-15", checked_in: true, claimed: false,
    reward: 0.05, balance: 12.4, range: { min: 0.01, max: 0.1 },
  })
  const hooks = await plugin()
  const out = await hooks.auth.checkin(async () => account())
  expect(out.outcome).toBe("done")
  expect(out.message).toMatch(/already in for 2026-10-15/)
})

test("a portal without a check-in configured reads as inactive", async () => {
  f = fakeBaipiao()
  checkinRoute(f, { ok: true, date: "2026-10-15", checked_in: false, claimed: false })
  const hooks = await plugin()
  const out = await hooks.auth.checkin(async () => account())
  expect(out.outcome).toBe("inactive")
})

test("a lapsed token says to sign in again; nothing renews it", async () => {
  f = fakeBaipiao()
  f.route("POST /api/checkin", () => json({ detail: "invalid or expired token" }, 401))
  const hooks = await plugin()
  await expect(hooks.auth.checkin(async () => account({ access: "gone" }))).rejects.toThrow(/sign in again/)
  expect(f.seen.length).toBe(1)
})

test("a check-in the portal turns away is a failed one with its message", async () => {
  f = fakeBaipiao()
  checkinRoute(f, { detail: "checkin reward range is invalid" }, 503)
  const hooks = await plugin()
  await expect(hooks.auth.checkin(async () => account())).rejects.toThrow(/checkin reward range/)
})
