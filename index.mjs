// bit-api (ai.baipiao.co) provider plugin for OpenCode and magpie.
//
// The site is a bitapi (kingenbomb/bitapi) gateway: OpenAI- and
// Anthropic-compatible at https://ai.baipiao.co/v1, billed from an account
// balance. Accounts sign in through the site's community login: the browser
// opens baipiao.org/bbs's OAuth page, the site's own callback page takes the
// authorization code and turns it into a session token (a JWT, 7 days by
// default), and the user pastes that token here. The token is what the
// account pages (/api/me, /api/overview, /api/keys, /api/checkin) answer;
// chat requests carry an API key (sk-…) instead, which the plugin picks off
// the account's first key, or the user types one in.
//
// bitapi issues no refresh token: a lapsed token signs in again the same way
// (open the browser, paste the fresh token).

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
// list without a token), as OpenAI's shape. magpie asks it with the account's
// first key when the account has one, else with what the user typed.
async function discoverModels(apiKey, signal) {
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

// ---- the keys ---------------------------------------------------------------

// firstKeyRaw asks the portal for the account's first active chat key. The
// list only names masked keys; the plain key comes from the reveal page of
// the first active id (what the console's own copy button asks).
async function firstKeyRaw(auth) {
  const v = await portalGet(auth, "/api/keys");
  const rows = Array.isArray(v) ? v : Array.isArray(v?.keys) ? v.keys : [];
  const row = rows.find((k) => k?.status === "active" && Number.isFinite(k?.id))
    ?? rows.find((k) => typeof k?.key === "string" && k.key);
  if (row?.key) return row.key; // a listing that does name plain keys
  const id = row?.id;
  if (!Number.isFinite(id)) throw new Error("bit-api keys: the account has no active key");
  const revealed = await portalGet(auth, `/api/keys/${id}/reveal`);
  const key = typeof revealed?.key === "string" ? revealed.key
    : typeof revealed?.full === "string" ? revealed.full : "";
  if (!key) throw new Error("bit-api keys: the portal named no plain key");
  return key;
}

// ---- the plugin -------------------------------------------------------------

export const BaipiaoPlugin = async ({ client } = {}) => {
  const save = (auth) => client?.auth?.set?.({ path: { id: PROVIDER }, body: auth })?.catch?.(() => {});
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
          authorize: () => authorizeCommunity(),
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
        if (auth.type === "api" || (auth.type === "oauth" && !auth.access))
          return { baseURL: `${hostOf()}/v1`, apiKey: auth.key ?? auth.apiKey };
        return { baseURL: `${hostOf()}/v1`, apiKey: auth.apiKey ?? (await firstKey(auth).catch(() => "")) };
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
        // an api-key account asks with its key; a community account asks with
        // its first key, and with its session token when it has no key yet
        // (the gateway accepts a token on /v1/models too) — so the list is
        // there as soon as the account is signed in
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
// page turns the code into a session token stored as
// localStorage["bitapi_token"] on ai.baipiao.co. The user pastes that token
// here. A chat key typed in the second prompt is used as it is; one pasted
// empty leaves the key to the account's own first active key. method "code"
// is what OpenCode's and magpie's sign-in dialogs do with it: one field, the
// answer comes back to authorize.
function authorizeCommunity() {
  return {
    url: `${HOST}/portal#/login`,
    instructions:
      "On the page that opens, sign in with the community button (社区登录), " +
      "a baipiao.org/bbs account. After it comes back to bit-api's page, copy " +
      "your session token: press F12 for the console on the bit-api tab and " +
      "run localStorage.bitapi_token, then paste what it prints here.",
    method: "code",
    callback: async (code0) => {
      const token = String(code0 ?? "").trim();
      if (!token) return { type: "failed", error: "Paste the session token" };
      // a wrong paste says so now, not on the first request
      try {
        await portalGet({ access: token }, "/api/me", undefined);
      } catch (e) {
        return { type: "failed", error: e instanceof Lapsed ? `The token was refused: ${e.message}` : `The token was refused: ${e?.message ?? e}` };
      }
      const access = token;
      // the account's first active key is picked up here (the keys list only
      // names masked keys, so the plain one comes from its reveal page); a
      // key typed at magpie's own api-key method wins whenever the user
      // prefers one
      // Auth (magpie's store) is a union: an OAuth account must carry refresh
      // and expires. bitapi signs no refresh token and the JWT's expiry is
      // the site's own (7 days by default), so expires 0 means "never renew
      // automatically"; a lapsed sign-in is renewed by signing in again.
      try {
        const apiKey = await firstKeyRaw({ access: token });
        return { type: "success", access, refresh: "none", expires: 0, apiKey, accountId: "bit-api" };
      } catch {
        // an account without a key yet still signs in; the loader picks the
        // key up later, once the user makes one
        return { type: "success", access, refresh: "none", expires: 0, accountId: "bit-api" };
      }
    },
  };
}

async function firstKey(auth) {
  const key = await firstKeyRaw(auth);
  return key;
}

export const _internal = { HOST, hostOf, PROVIDER, SDK, portalGet, usageOf, checkIn, discoverModels, firstKey, firstKeyRaw, authorizeCommunity, messageOf, money };
