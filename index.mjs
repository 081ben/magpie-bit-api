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
// console's Keys page once they are signed in. The sign-in therefore asks two
// questions, one after the other (magpie's own `ask` hook, as pi's sign-ins
// use): the session cookie, then the chat key. magpie asks a method's questions
// before it opens the browser, and the key only exists to copy after the login,
// so the plugin opens the login page itself as the first question comes up, and
// tells magpie it did (opened). The key is required — which key pays for chat is
// the user's call, so the plugin never guesses at the account's first one.
//
// bitapi issues no refresh token: a lapsed session signs in again the same way
// (open the browser, paste the fresh cookie and key).

import { spawn } from "node:child_process"

const HOST = "https://ai.baipiao.co";
const LOGIN_PAGE = `${HOST}/portal#/login`;
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

// ---- the browser ------------------------------------------------------------

// openInBrowserDefault opens url in the user's browser, the way magpie does:
// the login page has to be up before the first question can be answered, and
// magpie opens pages only once a method's questions are through.
function openInBrowserDefault(url) {
  try {
    const [cmd, args] =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// tests replace the opener, so a sign-in run there opens no browser
let openInBrowser = openInBrowserDefault;
const setLoginPageOpener = (fn) => {
  openInBrowser = typeof fn === "function" ? fn : openInBrowserDefault;
};

// The two questions, asked one at a time: the cookie, then the chat key. Their
// keys carry the attempt's number, so the answers of an attempt that failed
// don't fill in the questions of the next one. An answer that won't do is asked
// again with what is wrong with it in the question itself: magpie shows the
// question's words, and a sign-in that threw would end the whole attempt.
const NO_COOKIE = {
  en: "That paste carries no bitapi_session.",
  zh: "这段里没有 bitapi_session。",
  "zh-TW": "這段裡沒有 bitapi_session。",
};
const STALE_COOKIE = {
  en: "That cookie's session has expired — sign in again.",
  zh: "这段 cookie 的会话已过期，请重新登录。",
  "zh-TW": "這段 cookie 的工作階段已過期，請重新登入。",
};
const NOT_A_KEY = {
  en: "That isn't a chat key (sk-…).",
  zh: "这不是聊天密钥（sk-…）。",
  "zh-TW": "這不是聊天金鑰（sk-…）。",
};
const refused = (why) => ({
  en: `The site refused it: ${why}`,
  zh: `站点拒绝了这段凭据：${why}`,
  "zh-TW": `站點拒絕了這段憑據：${why}`,
});

const cookieQuestion = (n, pageOpened = true, wrong = null) => ({
  type: "text",
  key: `cookie${n}`,
  message:
    (wrong ? `${wrong.en} ` : "") +
    (pageOpened
      ? "In the login page magpie opened, sign in with the community button (社区登录), then paste the session cookie: "
      : `Open ${LOGIN_PAGE} and sign in with the community button (社区登录), then paste the session cookie: `) +
    "F12 → Application → Cookies → https://ai.baipiao.co → bitapi_session's value " +
    "(or the whole Cookie header of any /api request)",
  messages: {
    zh:
      (wrong ? `${wrong.zh} ` : "") +
      (pageOpened
        ? "在已打开的登录页里用社区登录（社区登录按钮）登入，然后粘贴会话 cookie："
        : `打开 ${LOGIN_PAGE} 并用社区登录（社区登录按钮）登入，然后粘贴会话 cookie：`) +
      "F12 → Application → Cookies → https://ai.baipiao.co → 复制 bitapi_session 的值" +
      "（或任一 /api 请求的整条 Cookie 头）",
    "zh-TW":
      (wrong ? `${wrong["zh-TW"]} ` : "") +
      (pageOpened
        ? "在已開啟的登入頁裡用社群登入（社區登入按鈕）登入，然後貼上工作階段 cookie："
        : `開啟 ${LOGIN_PAGE} 並用社群登入（社區登入按鈕）登入，然後貼上工作階段 cookie：`) +
      "F12 → Application → Cookies → https://ai.baipiao.co → 複製 bitapi_session 的值" +
      "（或任一 /api 請求的整條 Cookie 標頭）",
  },
  placeholder: "bitapi_session=…",
});

const keyQuestion = (n, wrong = null) => ({
  type: "password",
  key: `key${n}`,
  message: (wrong ? `${wrong.en} ` : "") + "Paste your chat key: sk-…, from the console's Keys page",
  messages: {
    zh: (wrong ? `${wrong.zh} ` : "") + "粘贴聊天密钥：sk-…（控制台 Keys 页）",
    "zh-TW": (wrong ? `${wrong["zh-TW"]} ` : "") + "貼上聊天金鑰：sk-…（控制台 Keys 頁）",
  },
  placeholder: "sk-…",
});

async function readResponse(res) {
  const text = await res.text();
  return { status: res.status, text, v: parseJSON(text) };
}

class Lapsed extends Error {}
// Unreachable is the site not answering at all (no network, a timeout): not the
// user's paste being wrong, so a sign-in step says nothing about it.
class Unreachable extends Error {}

// ---- the portal's pages -----------------------------------------------------

// portalGet asks one of the account's JSON pages with the session token. A
// token the site turned away (401) is a lapsed sign-in: bitapi has no refresh
// token, so the account marks and the user signs in again. The caller decides
// what a lapse reads as.
async function portalGet(auth, path, signal) {
  let r;
  try {
    r = await readResponse(
      await fetch(`${hostOf()}${path}`, {
        headers: { ...jsonHeaders, authorization: `Bearer ${auth.access}` },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      }),
    );
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Unreachable(`bit-api couldn't be reached: ${e?.message ?? e}`);
  }
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

// ---- the community sign-in --------------------------------------------------

// signInCommunity finishes the community sign-in with what the two questions
// collected: the session cookie's value and the chat key. The token is checked
// against /api/me, so a wrong paste says so now rather than on the first
// request. The page is already open (opened), so magpie doesn't open it again;
// its callback hands over what was checked, and the sign-in ends there.
//
// Auth (magpie's store) is a union: an OAuth account must carry refresh and
// expires. bitapi signs no refresh token and the JWT's expiry is the site's own
// (7 days by default), so expires 0 means "never renew automatically"; a lapsed
// sign-in is renewed by signing in again.
async function signInCommunity({ cookie, key, opened }) {
  const token = sessionToken(cookie);
  if (!token) {
    return {
      type: "failed",
      error: "Paste the bitapi_session cookie's value (or the whole Cookie header of an /api request)",
    };
  }
  if (!isKey(key)) {
    return { type: "failed", error: "Paste your chat key too (sk-…, from the console's Keys page)" };
  }
  let me;
  try {
    me = await portalGet({ access: token }, "/api/me", undefined);
  } catch (e) {
    if (e instanceof Unreachable) {
      return { type: "failed", error: `Couldn't check the cookie: ${e.message}` };
    }
    return {
      type: "failed",
      error: e instanceof Lapsed ? `The token was refused: ${e.message}` : `The token was refused: ${e?.message ?? e}`,
    };
  }
  // the account is named by the site's own id for it, so a second sign-in to
  // the same account replaces that one while another account sits beside it
  const who = String(me?.email ?? "").trim() || (me?.id ? `bit-api #${me.id}` : "bit-api");
  const chat = String(key).trim();
  return {
    url: LOGIN_PAGE,
    opened: opened === true,
    method: "auto",
    callback: async () => ({
      type: "success",
      access: token,
      refresh: "none",
      expires: 0,
      apiKey: chat,
      accountId: who,
    }),
  };
}

// checkCookie asks /api/me with the pasted cookie's session token: null when the
// site knows it, else what is wrong with the paste. It is asked as the cookie is
// answered, so a stale token or a paste that carries none says so before the
// user goes looking for the key. A site that can't be reached says nothing: the
// answer goes on, and the sign-in's own check reports what it finds.
async function checkCookie(cookie) {
  const token = sessionToken(cookie);
  if (!token) return NO_COOKIE;
  try {
    await portalGet({ access: token }, "/api/me", undefined);
    return null;
  } catch (e) {
    if (e instanceof Lapsed) return STALE_COOKIE;
    if (e instanceof Unreachable) return null;
    return refused(e?.message ?? e);
  }
}

// ---- the plugin -------------------------------------------------------------

export const BaipiaoPlugin = async () => {
  // the last model list this process discovered, so a config read before the
  // account's list is asked still offers models
  let last = {};

  // the sign-in under way: which attempt it is (the questions' keys carry its
  // number, so a retry doesn't inherit the last one's answers), whether the
  // login page was opened, and the answers the questions collected for
  // authorize. magpie hands an ask-based method's answers nowhere, so they
  // wait here.
  let attempt = null;
  let runs = 0;
  let pending = null;

  const ask = async (inputs = {}) => {
    const a = inputs ?? {};
    // nothing answered: a sign-in begun afresh (a retry after a failure), with
    // its own questions and the login page opened again
    if (Object.keys(a).length === 0) {
      attempt = { n: ++runs, opened: false, page: false };
      pending = null;
    }
    // the answers are in: magpie asks once more before it authorizes
    if (pending) return null;
    if (!attempt) attempt = { n: ++runs, opened: false, page: false };
    const n = attempt.n;
    if (!attempt.opened) {
      attempt.opened = true;
      attempt.page = openInBrowser(LOGIN_PAGE);
    }
    const said = (k) => (typeof a[k] === "string" ? a[k].trim() : "");
    const cookie = said(`cookie${n}`);
    if (!cookie) return cookieQuestion(n, attempt.page);
    // the token is checked as it is pasted, so a stale one says so here rather
    // than after the key is copied too. magpie asks the same question again on
    // its way to authorize, so the answer that was checked is kept.
    if (attempt.checked !== cookie) {
      const bad = await checkCookie(cookie);
      if (bad) return cookieQuestion(n, attempt.page, bad);
      attempt.checked = cookie;
    }
    const key = said(`key${n}`);
    if (!key) return keyQuestion(n);
    if (!isKey(key)) return keyQuestion(n, NOT_A_KEY);
    pending = { cookie, key, opened: attempt.page };
    return null;
  };

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
      // no auth.icon: package.json's magpie.icon carries the provider's icon,
      // and the site's own favicon.ico is a 404
      provider: PROVIDER,
      methods: [
        {
          type: "oauth",
          label: "bit-api community sign-in (browser)",
          // two questions, one after the other: the cookie, then the chat key
          // (magpie asks a method's prompts before the browser, and the key
          // only exists to copy after the login)
          ask,
          authorize: async () => {
            const a = pending;
            attempt = null;
            pending = null;
            if (!a) {
              return {
                type: "failed",
                error: "Paste the session cookie and your chat key first (sign in again)",
              };
            }
            return signInCommunity(a);
          },
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

export const _internal = {
  HOST,
  LOGIN_PAGE,
  hostOf,
  PROVIDER,
  SDK,
  portalGet,
  usageOf,
  checkIn,
  discoverModels,
  signInCommunity,
  openInBrowserDefault,
  setLoginPageOpener,
  messageOf,
  money,
  sessionToken,
  isKey,
};
