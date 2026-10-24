// Интернет для Киры: поиск и чтение страниц.
//
// Поиск идёт через один из сервисов — какой ключ задан, тот и используется (порядок ниже).
// Если ключей нет или сервис не ответил — запасной вариант без ключа: выдача Bing (разбор HTML),
// потом DuckDuckGo. Это хрупко (вёрстка меняется, могут показать капчу), поэтому ключ лучше задать.
//   YANDEX_SEARCH_API_KEY + YANDEX_FOLDER_ID — Яндекс Search API (Yandex Cloud), лучше всего для русских запросов
//   TAVILY_API_KEY  — Tavily
//   BRAVE_API_KEY   — Brave Search
//   SERPER_API_KEY  — Serper (выдача Google)
// WEB_SEARCH_PROVIDER — принудительно выбрать один (yandex | tavily | brave | serper | bing | duckduckgo).
//
// Чтение страницы: скачиваем, переводим в простой текст (без меню, скриптов, стилей), обрезаем.
// В локальную сеть и на сам хостинг ходить нельзя (защита от SSRF).

import dns from "node:dns/promises";
import net from "node:net";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const PAGE_CHARS = 9000;

export function webProviders(cfg = {}) {
  const all = [];
  if (cfg.yandexKey && cfg.yandexFolder) all.push("yandex");
  if (cfg.tavilyKey) all.push("tavily");
  if (cfg.braveKey) all.push("brave");
  if (cfg.serperKey) all.push("serper");
  all.push("bing", "duckduckgo");
  if (cfg.provider && all.includes(cfg.provider)) return [cfg.provider, ...all.filter((p) => p !== cfg.provider)];
  return all;
}

export function createWeb(cfg = {}, { fetchImpl = globalThis.fetch, lookup = dns.lookup, log = () => {} } = {}) {
  async function get(url, { headers = {}, method = "GET", body, timeoutMs = 15000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { method, headers: { "User-Agent": UA, "Accept-Language": "ru,en;q=0.8", ...headers }, body, signal: ctrl.signal, redirect: "follow" });
    } catch (e) {
      throw new Error(e.name === "AbortError" ? "не ответил вовремя" : e.message);
    } finally {
      clearTimeout(timer);
    }
  }

  async function json(res, name) {
    const text = await res.text();
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${text.slice(0, 150)}`);
    try { return JSON.parse(text); } catch { throw new Error(`${name}: непонятный ответ`); }
  }

  const providers = {
    async yandex(q, n) {
      const res = await get("https://searchapi.api.cloud.yandex.net/v2/web/search", {
        method: "POST",
        headers: { Authorization: `Api-Key ${cfg.yandexKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: { searchType: "SEARCH_TYPE_RU", queryText: q, familyMode: "FAMILY_MODE_NONE" },
          folderId: cfg.yandexFolder, responseFormat: "FORMAT_XML",
          groupSpec: { groupMode: "GROUP_MODE_DEEP", groupsOnPage: String(n), docsInGroup: "1" },
          l10n: "LOCALIZATION_RU",
        }),
      });
      const data = await json(res, "Яндекс");
      if (!data.rawData) throw new Error("Яндекс: пустой ответ");
      return parseYandexXml(Buffer.from(data.rawData, "base64").toString("utf8")).slice(0, n);
    },
    async tavily(q, n) {
      const res = await get("https://api.tavily.com/search", {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.tavilyKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, max_results: n, search_depth: "basic" }),
      });
      const data = await json(res, "Tavily");
      return (data.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content, date: r.published_date }));
    },
    async brave(q, n) {
      const res = await get(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}&search_lang=ru`, {
        headers: { "X-Subscription-Token": cfg.braveKey, Accept: "application/json" },
      });
      const data = await json(res, "Brave");
      return (data.web?.results || []).map((r) => ({ title: stripTags(r.title), url: r.url, snippet: stripTags(r.description || ""), date: r.age }));
    },
    async serper(q, n) {
      const res = await get("https://google.serper.dev/search", {
        method: "POST",
        headers: { "X-API-KEY": cfg.serperKey, "Content-Type": "application/json" },
        body: JSON.stringify({ q, num: n, gl: "ru", hl: "ru" }),
      });
      const data = await json(res, "Serper");
      return (data.organic || []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet, date: r.date }));
    },
    async bing(q, n) {
      const res = await get(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=ru&cc=RU&count=${Math.max(n, 10)}`, {
        headers: { Accept: "text/html,application/xhtml+xml", Cookie: "SRCHHPGUSR=ADLT=OFF" },
      });
      const html = await res.text();
      if (!res.ok) throw new Error(`Bing: HTTP ${res.status}`);
      const out = parseBing(html);
      if (!out.length && /captcha|challenge/i.test(html)) throw new Error("Bing попросил капчу");
      return out.slice(0, n);
    },
    async duckduckgo(q, n) {
      const res = await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=ru-ru`);
      const html = await res.text();
      if (!res.ok) throw new Error(`DuckDuckGo: HTTP ${res.status}`);
      const out = parseDuckDuckGo(html);
      if (!out.length && /anomaly|captcha/i.test(html)) throw new Error("DuckDuckGo попросил капчу");
      return out.slice(0, n);
    },
  };

  async function search(query, { limit = 6 } = {}) {
    const q = String(query || "").trim().slice(0, 400);
    if (!q) throw new Error("Пустой запрос");
    const n = Math.min(Math.max(+limit || 6, 1), 10);
    const errors = [];
    for (const p of webProviders(cfg)) {
      try {
        const results = (await providers[p](q, n))
          .filter((r) => r.url && /^https?:/i.test(r.url))
          .map((r) => ({ title: clip(r.title, 200), url: r.url, snippet: clip(r.snippet, 400), ...(r.date ? { date: r.date } : {}) }));
        if (results.length) return { provider: p, results };
        errors.push(`${p}: пусто`);
      } catch (e) {
        log(`поиск ${p}: ${e.message}`);
        errors.push(`${p}: ${e.message}`);
      }
    }
    throw new Error(`Поиск не удался (${errors.join("; ")})`);
  }

  async function read(url, { maxChars = PAGE_CHARS } = {}) {
    let u;
    try { u = new URL(String(url)); } catch { throw new Error("Неверная ссылка"); }
    if (!/^https?:$/.test(u.protocol)) throw new Error("Читаю только http(s)-ссылки");
    await assertPublicHost(u.hostname, lookup);
    const res = await get(u.href, { headers: { Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" }, timeoutMs: 20000 });
    if (!res.ok) throw new Error(`Страница ответила HTTP ${res.status}`);
    // после редиректов — ещё раз проверить, куда пришли
    if (res.url && res.url !== u.href) await assertPublicHost(new URL(res.url).hostname, lookup);
    const type = (res.headers.get("content-type") || "").toLowerCase();
    if (/pdf/.test(type)) throw new Error("Это PDF — такие документы я пока не читаю");
    if (type && !/text|html|xml|json/.test(type)) throw new Error(`Это не страница, а файл (${type.split(";")[0]})`);
    const buf = await readLimited(res, MAX_PAGE_BYTES);
    const html = decode(buf, type);
    const page = htmlToText(html);
    const limit = Math.min(Math.max(+maxChars || PAGE_CHARS, 1000), 20000);
    return {
      url: res.url || u.href,
      title: page.title,
      ...(page.date ? { date: page.date } : {}),
      text: page.text.length > limit ? page.text.slice(0, limit) + "\n…(обрезано)" : page.text,
      truncated: page.text.length > limit,
    };
  }

  return { search, read, providers: webProviders(cfg) };
}

// ---------- разбор выдачи ----------

export function parseBing(html) {
  const out = [];
  for (const block of html.match(/<li class="b_algo[\s\S]*?(?=<li class="b_algo|<li class="b_pag|<\/ol>)/g) || []) {
    const a = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = decodeEntities(a[1]);
    // ссылка-переадресация bing.com/ck/a?…&u=a1<base64url>
    const enc = url.match(/[?&]u=a1([^&]+)/);
    if (/bing\.com\/ck\//.test(url) && enc) {
      try { url = Buffer.from(enc[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch { continue; }
    }
    if (!/^https?:\/\//.test(url) || /^https?:\/\/(www\.)?bing\.com\//.test(url)) continue;
    const p = block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/) || block.match(/class="b_caption"[^>]*>([\s\S]*?)<\/div>/);
    let snippet = p ? stripTags(p[1].replace(/<span class="algoSlug_icon"[\s\S]*?<\/span>/g, "")) : "";
    const date = (snippet.match(/^(\d{1,2} \S+ \d{4} г?\.?)\s*[·—-]\s*/) || [])[1];
    if (date) snippet = snippet.slice(snippet.indexOf(date) + date.length).replace(/^\s*[·—-]\s*/, "");
    out.push({ title: stripTags(a[2]), url, snippet, ...(date ? { date } : {}) });
  }
  return out;
}

export function parseDuckDuckGo(html) {
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="result__a"|$)/g;
  let m;
  while ((m = re.exec(html))) {
    let href = decodeEntities(m[1]);
    const ud = href.match(/[?&]uddg=([^&]+)/);
    if (ud) href = decodeURIComponent(ud[1]);
    if (href.startsWith("//")) href = "https:" + href;
    if (/duckduckgo\.com\/y\.js/.test(href)) continue; // реклама
    const sn = m[3].match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    out.push({ title: stripTags(m[2]), url: href, snippet: sn ? stripTags(sn[1]) : "" });
  }
  return out;
}

export function parseYandexXml(xml) {
  const out = [];
  for (const doc of xml.match(/<doc\b[\s\S]*?<\/doc>/g) || []) {
    const tag = (t) => (doc.match(new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || "";
    const passages = (doc.match(/<passage\b[^>]*>[\s\S]*?<\/passage>/g) || []).map(stripTags).join(" … ");
    out.push({
      title: stripTags(tag("title")),
      url: stripTags(tag("url")),
      snippet: passages || stripTags(tag("headline")),
      date: (tag("modtime").match(/^(\d{4})(\d{2})(\d{2})/) || []).slice(1).join("-") || undefined,
    });
  }
  return out;
}

// ---------- страница в текст ----------

export function htmlToText(html) {
  let s = String(html);
  const title = stripTags((s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").slice(0, 300);
  const date = (s.match(/<meta[^>]+(?:property|name|itemprop)="(?:article:published_time|datePublished|date|pubdate)"[^>]+content="([^"]+)"/i) || [])[1]
    || (s.match(/<time[^>]+datetime="([^"]+)"/i) || [])[1];
  s = s.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|form|select|button)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
  // если есть основная часть страницы — берём её
  const main = longest(s.match(/<article\b[\s\S]*?<\/article>/gi)) || longest(s.match(/<main\b[\s\S]*?<\/main>/gi));
  if (main && stripTags(main).length > 400) s = main;
  else s = (s.match(/<body\b[\s\S]*<\/body>/i) || [s])[0].replace(/<header\b[\s\S]*?<\/header>/gi, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/(p|div|section|h[1-6]|li|tr|table|ul|ol|blockquote|pre|dd|dt)>/gi, "\n")
    .replace(/<(h[1-6])\b[^>]*>/gi, "\n\n")
    .replace(/<\/t[dh]>/gi, " | ");
  const text = decodeEntities(s.replace(/<[^>]+>/g, " "))
    .split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l, i, arr) => l && l !== "•" && !(l.length < 3 && arr[i - 1]?.length < 3))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title, date, text };
}

function longest(arr) {
  return arr?.length ? arr.reduce((a, b) => (b.length > a.length ? b : a)) : null;
}

export function stripTags(s) {
  return decodeEntities(String(s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»", mdash: "—", ndash: "–", hellip: "…", copy: "©", reg: "®", trade: "™", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bdquo: "„", middot: "·", bull: "•", deg: "°", times: "×", euro: "€", shy: "" };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function clip(s, n) {
  s = String(s || "").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function decode(buf, type) {
  let cs = (type.match(/charset=([\w-]+)/i) || [])[1];
  if (!cs) {
    const head = buf.subarray(0, 4096).toString("latin1");
    cs = (head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  }
  cs = (cs || "utf-8").toLowerCase();
  if (cs === "cp1251") cs = "windows-1251";
  try { return new TextDecoder(cs).decode(buf); } catch { return new TextDecoder("utf-8").decode(buf); }
}

async function readLimited(res, max) {
  if (!res.body?.getReader) return Buffer.from(await res.arrayBuffer()).subarray(0, max);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, max);
}

// ---------- защита: только публичные адреса ----------

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

async function assertPublicHost(host, lookup) {
  const h = host.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(h)) throw new Error("Во внутреннюю сеть не хожу");
  const addrs = net.isIP(h) ? [{ address: h }] : await lookup(h, { all: true }).catch(() => { throw new Error(`Не нашла сайт ${h}`); });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("Во внутреннюю сеть не хожу");
}
