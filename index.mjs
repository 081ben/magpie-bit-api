// bit-api (ai.baipiao.co) provider plugin for magpie.
//
// The site is a bitapi (kingenbomb/bitapi) gateway: OpenAI- and
// Anthropic-compatible at https://ai.baipiao.co/v1, billed from an account
// balance. Accounts sign in through the site's community login: the browser
// opens baipiao.org/bbs's OAuth page, and the site's own callback page turns
// the authorization code into a session (a JWT, 7 days by default).
//
// The portal keeps that session in the HttpOnly cookie bitapi_session, which
// page scripts cannot read — the site's own JS calls localStorage.removeItem
// ("bitapi_token") on load, so the token is no longer there. The user copies
// the cookie's value from the browser's DevTools instead (Application →
// Cookies), or the whole cookie string, and pastes it here. The value is the
// JWT itself, and bitapi still accepts script clients' Bearer tokens on every
// /api page (cookie sessions would need a CSRF header on POST), so the plugin
// sends it as Bearer.
//
// Chat requests carry an API key (sk-…) instead, which the user copies off the
// console's Keys page. The sign-in asks for it up front as a "prompts"
// question (magpie's own field) and requires it: which key pays for chat is the
// user's call, so the plugin never guesses at the account's first one.
//
// bitapi issues no refresh token: a lapsed session signs in again the same way
// (open the browser, copy the fresh cookie).

const HOST = "https://ai.baipiao.co";
// tests point the plugin at a local stand-in for the portal
const hostOf = () => globalThis.__BAIPIAO_HOST__ ?? HOST;
const PROVIDER = "baipiao";
const SDK = {
  chat: "@ai-sdk/openai-compatible",
  responses: "@ai-sdk/openai",
  anthropic: "@ai-sdk/anthropic",
};

const jsonHeaders = { "content-type": "application/json", accept: "application/json" };

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const messageOf = (v, status, text) =>
  String(v?.detail ?? v?.message ?? text?.trim().slice(0, 200) ?? `HTTP ${status}`);

// sessionToken takes what the user pasted and returns the session JWT. The
// portal keeps it in the HttpOnly cookie bitapi_session, so the paste is often
// the cookie's value alone; a whole Cookie header pasted out of DevTools
// ("bitapi_session=…; bitapi_csrf=…") is accepted too, as is a bare JWT from
// an older sign-in.
function sessionToken(pasted) {
  const raw = String(pasted ?? "").trim().replace(/^cookie:\s*/i, "");
  if (!raw) return "";
  if (!raw.includes("=")) return raw;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === "bitapi_session") return part.slice(i + 1).trim();
  }
  return "";
}

const isKey = (v) => /^sk-\S+$/.test(String(v ?? "").trim());

async function readResponse(res) {
  const text = await res.text();
  return { status: res.status, text, v: parseJSON(text) };
}

class Lapsed extends Error {}

// ---- the portal's pages -----------------------------------------------------

// portalGet asks one of the account's JSON pages with the session token. A
// token the site turned away (401) is a lapsed sign-in: bitapi has no refresh
// token, so the account marks and the user signs in again. The caller decides
// what a lapse reads as.
async function portalGet(auth, path, signal) {
  const r = await readResponse(
    await fetch(`${hostOf()}${path}`, {
      headers: { ...jsonHeaders, authorization: `Bearer ${auth.access}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    }),
  );
  if (r.status === 401) throw new Lapsed("bit-api's sign-in has expired — sign in again");
  if (r.status !== 200) throw new Error(`bit-api ${path}: ` + messageOf(r.v, r.status, r.text));
  return r.v;
}

// ---- what the account reads -------------------------------------------------

const money = (n) => "$" + (Math.round(Number(n) * 100) / 100).toFixed(2);

// usageOf reads /api/overview: the balance and what the account spent today.
// bit-api bills a balance, not a plan window, so the card is the balance
// line, with today's spend as one window.
function usageOf(v) {
  const out = {
    plan: "bit-api",
    user: v.group ? String(v.group) : undefined,
    signIn: "kept",
  };
  const balance = Number(v.balance);
  if (Number.isFinite(balance)) out.balance = money(balance);
  const today = v.today ?? {};
  const spent = Number(today.cost);
  const requests = Number(today.requests);
  if (Number.isFinite(spent) && spent !== 0)
    out.windows = [
      {
        name: "Today",
        display: `${money(spent)} · ${Number.isFinite(requests) ? requests : "?"} requests`,
      },
    ];
  const checkin = v.checkin;
  if (checkin) out.checkin = { date: checkin.date, checked_in: !!checkin.checked_in };
  return out;
}

// ---- the models -------------------------------------------------------------

// The gateway's /v1/models answers what the key's group serves (the guest
// list without a token), as OpenAI's shape. magpie asks it with the key the
// user named at sign-in, or their session token when an account has no key.
// magpie asks for the model table on every picker open, and the site takes
// seconds to answer, so answers are cached for a day: the table only changes
// when the site's group config does, and the picker must not pay the site's
// latency every time.
const MODELS_TTL = 24 * 60 * 60 * 1000;
const modelsCache = { at: 0, key: null, models: null };

async function discoverModels(apiKey, signal) {
  const cached =
    modelsCache.models &&
    modelsCache.key === (apiKey ?? "") &&
    Date.now() - modelsCache.at < MODELS_TTL;
  if (cached) return modelsCache.models;
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const res = await fetch(`${hostOf()}/v1/models`, {
    headers,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  const { status, text, v } = await readResponse(res);
  if (status !== 200) throw new Error("bit-api models: " + messageOf(v, status, text));
  const rows = Array.isArray(v?.data) ? v.data : [];
  const models = {};
  for (const row of rows) {
    const id = typeof row?.id === "string" ? row.id : "";
    if (!id || id === "__proto__") continue;
    models[id] = {
      id,
      name: row.name ?? id,
      // the gateway itself translates Anthropic Messages to OpenAI and back,
      // so one entry serves every protocol
      provider: { npm: SDK.chat, api: `${hostOf()}/v1` },
      tool_call: true,
    };
  }
  if (Object.keys(models).length) {
    modelsCache.at = Date.now();
    modelsCache.key = apiKey ?? "";
    modelsCache.models = models;
  }
  return models;
}

// ---- the check-in -----------------------------------------------------------

// The portal's own daily check-in: POST /api/checkin, once a UTC+8 day. The
// answer's claimed says whether it was claimed now or already today. The
// reward is a random amount the site picks.
async function checkIn(auth) {
  const r = await readResponse(
    await fetch(`${hostOf()}/api/checkin`, {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${auth.access}` },
      signal: AbortSignal.timeout(20_000),
    }),
  );
  if (r.status === 401) throw new Lapsed("bit-api's sign-in has expired — sign in again");
  if (r.status !== 200) throw new Error("bit-api check-in: " + messageOf(r.v, r.status, r.text));
  const v = r.v ?? {};
  if (v.claimed === false) {
    // /api/overview's checkin row says whether today was already in before
    // this call; a site without a check-in configured (no range) reads as done
    if (v.checked_in === false) return { outcome: "inactive" };
    return { outcome: "done", message: v.date ? `already in for ${v.date}` : "already in today" };
  }
  const reward = Number(v.reward);
  const credit = Number.isFinite(reward) ? money(reward) : undefined;
  const balance = Number(v.balance);
  return {
    outcome: "claimed",
    credit,
    message:
      credit !== undefined
        ? `+ ${credit}${Number.isFinite(balance) ? ` · ${money(balance)}` : ""}`
        : "checked in",
  };
}

// ---- the chat key -----------------------------------------------------------

// The chat key is the user's, asked at sign-in: the console's Keys page is
// where it comes from, and the plugin keeps it as the account's apiKey. The
// account's own list (/api/keys and its reveal pages) is never consulted, so
// the key that pays for chat is the one the user named rather than whichever
// key the account happens to have first.

// ---- the plugin -------------------------------------------------------------

export const BaipiaoPlugin = async () => {
  // the last model list this process discovered, so a config read before the
  // account's list is asked still offers models
  let last = {};

  const withToken = async (getAuth) => {
    const auth = await getAuth();
    if (!auth || auth.type !== "oauth" || !auth.access) throw new Error("bit-api is not signed in");
    return auth;
  };

  return {
    async config(cfg) {
      cfg.provider ??= {};
      // models.dev has no bit-api entry, so the provider is declared here. The
      // model table starts from the last this process discovered (kept below),
      // so the picker is not empty before the account's own list is read; the
      // fields magpie needs to speak to the site are set even if something
      // else pre-wrote the entry.
      const was = cfg.provider[PROVIDER] ?? {};
      cfg.provider[PROVIDER] = {
        ...was,
        name: was.name ?? "bit-api",
        npm: was.npm ?? SDK.chat,
        api: was.api ?? `${HOST}/v1`,
        models: { ...last, ...(was.models ?? {}) },
      };
    },
    auth: {
      provider: PROVIDER,
      icon: "https://ai.baipiao.co/favicon.ico",
      methods: [
        {
          type: "oauth",
          label: "bit-api community sign-in (browser)",
          // the chat key is asked before the browser opens, as magpie's
          // prompts do: which key pays for chat is the user's call
          prompts: [
            {
              type: "password",
              key: "apiKey",
              message: "Chat key (sk-…, from the console's Keys page)",
              placeholder: "sk-…",
              validate: (v) => (isKey(v) ? undefined : "A chat key starts with sk-"),
            },
          ],
          authorize: (inputs) => authorizeCommunity(inputs),
        },
        {
          type: "api",
          label: "bit-api API key (chat key, sk-…)",
          placeholder: "sk-…",
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth) return {};
        return { baseURL: `${hostOf()}/v1`, apiKey: auth.key ?? auth.apiKey ?? "" };
      },
      async usage(getAuth) {
        const auth = await withToken(getAuth);
        try {
          const v = await portalGet(auth, "/api/overview");
          return usageOf(v);
        } catch (e) {
          const lapsed = e instanceof Lapsed;
          return {
            error: lapsed ? e.message : `bit-api overview: ${e?.message ?? e}`,
            signIn: lapsed ? "expired" : "kept",
          };
        }
      },
      async checkin(getAuth) {
        return checkIn(await withToken(getAuth));
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        // the key the user named asks for the list; an account that has none
        // yet falls back to its session token, which /v1/models also takes
        const key = auth?.type === "api" ? auth.key : auth?.apiKey;
        const list = await discoverModels(key)
          .catch(() => (auth?.access ? discoverModels(auth.access) : null))
          .catch(() => null);
        if (list && Object.keys(list).length) {
          last = list;
          return list;
        }
        return provider.models ?? {};
      },
    },
  };
};

// authorizeCommunity runs the site's community login in the user's browser.
// The site's sign-in flow is bound to an HttpOnly cookie (bitapi_community_flow)
// that only the browser that asks /api/community/auth/start gets, so the
// plugin must not ask for the authorize URL itself: a URL fetched here would
// carry a flow the browser never saw, and the callback would answer
// "community authorization state is missing". The browser starts the flow
// itself, on the portal's login page (社区登录 there), and the site's callback
// page turns the code into a session — kept in the HttpOnly cookie
// bitapi_session on ai.baipiao.co, with the matching bitapi_csrf beside it.
// Page scripts cannot read bitapi_session, and the site clears any
// localStorage["bitapi_token"] left over from the old sign-in, so the user
// copies the cookie from DevTools instead: Application → Cookies →
// https://ai.baipiao.co → bitapi_session, or the whole Cookie header the
// Network tab shows. The plugin takes the JWT out of either form and sends it
// as a Bearer token.
//
// The chat key is asked by the method's prompts before this runs, so the paste
// here is the session cookie alone.
function authorizeCommunity(inputs) {
  const apiKey = String(inputs?.apiKey ?? "").trim();
  if (!isKey(apiKey)) {
    return {
      type: "failed",
      error: "The chat key is missing: paste the sk-… key from the console's Keys page",
    };
  }
  return {
    url: `${HOST}/portal#/login`,
    instructions:
      "On the page that opens, sign in with the community button (社区登录), " +
      "a baipiao.org/bbs account. Back on bit-api's page, copy the session cookie: " +
      "press F12, open Application → Cookies → https://ai.baipiao.co, and copy " +
      "bitapi_session's value (or copy the whole Cookie header of any /api request " +
      "from the Network tab). Paste it here. The site no longer keeps the token in " +
      "localStorage.",
    method: "code",
    callback: async (code0) => {
      const token = sessionToken(code0);
      if (!token) {
        return {
          type: "failed",
          error: "Paste the bitapi_session cookie's value (or the whole Cookie header)",
        };
      }
      // a wrong paste says so now, not on the first request
      try {
        await portalGet({ access: token }, "/api/me", undefined);
      } catch (e) {
        return { type: "failed", error: e instanceof Lapsed ? `The token was refused: ${e.message}` : `The token was refused: ${e?.message ?? e}` };
      }
      // Auth (magpie's store) is a union: an OAuth account must carry refresh
      // and expires. bitapi signs no refresh token and the JWT's expiry is
      // the site's own (7 days by default), so expires 0 means "never renew
      // automatically"; a lapsed sign-in is renewed by signing in again.
      return { type: "success", access: token, refresh: "none", expires: 0, apiKey, accountId: "bit-api" };
    },
  };
}

export const _internal = { HOST, hostOf, PROVIDER, SDK, portalGet, usageOf, checkIn, discoverModels, authorizeCommunity, messageOf, money, sessionToken, isKey };
