// Интернет для Киры: разбор выдачи, текст страницы, защита от внутренней сети, инструменты и лимиты.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createWeb, parseBing, parseDuckDuckGo, parseYandexXml, htmlToText, isPrivateIp, webProviders } from "../src/ai/web.js";
import { createToolRunner, toolDefs } from "../src/ai/tools.js";
import { toHtml } from "../src/telegram.js";

const DDG = `
<div class="result results_links"><h2 class="result__title">
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fglobyte.ru%2Fcases%2Ftbank&amp;rut=abc">Глоубайт &mdash; кейс <b>Т-Банк</b></a></h2>
<a class="result__snippet" href="x">Внедрение платформы для <b>Т-Банка</b>: сроки &amp; результаты</a></div>
<div class="result"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad=1">Реклама</a></div>
<div class="result"><a rel="nofollow" class="result__a" href="https://vc.ru/news/1">Новость</a>
<a class="result__snippet" href="y">Текст новости</a></div>`;

const YA = `<?xml version="1.0" encoding="utf-8"?><yandexsearch><response><results><grouping>
<group><doc id="1"><url>https://globyte.ru/</url><domain>globyte.ru</domain><title>Глоубайт — <hlword>интегратор</hlword></title>
<modtime>20260312T101010</modtime><passages><passage>Работаем с <hlword>Т-Банком</hlword> с 2021 года</passage><passage>Проекты</passage></passages></doc></group>
<group><doc id="2"><url>https://tbank.ru/about</url><title>О банке</title><headline>Т-Банк</headline></doc></group>
</grouping></results></response></yandexsearch>`;

test("выдача DuckDuckGo: ссылки раскодированы, реклама выброшена", () => {
  const r = parseDuckDuckGo(DDG);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { title: "Глоубайт — кейс Т-Банк", url: "https://globyte.ru/cases/tbank", snippet: "Внедрение платформы для Т-Банка: сроки & результаты" });
  assert.equal(r[1].url, "https://vc.ru/news/1");
});

const BING = `<ol id="b_results"><li class="b_algo" data-id=""><div class="b_tpcn"><a class="tilk" href="https://globyte.ru/"><div class="tpic">Глоубайт</div></a></div>
<h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1${Buffer.from("https://globyte.ru/cases/tbank").toString("base64").replace(/=+$/, "")}&amp;ntb=1" h="ID=SERP,5">Кейс: <strong>Т-Банк</strong> &amp; Глоубайт</a></h2>
<div class="b_caption"><p class="b_lineclamp2"><span class="algoSlug_icon" data-priority="2">WEB</span>12 мая 2025 г. · Глоубайт внедрил платформу для <strong>Т-Банка</strong></p></div></li>
<li class="b_algo"><h2><a href="https://vc.ru/x" h="ID=SERP,6">Новость</a></h2><div class="b_caption"><p>Текст</p></div></li>
<li class="b_algo"><h2><a href="https://www.bing.com/images/search?q=x">Картинки</a></h2></li><li class="b_pag"></li></ol>`;

test("выдача Bing: ссылки-переадресации раскодированы, дата отделена", () => {
  const r = parseBing(BING);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { title: "Кейс: Т-Банк & Глоубайт", url: "https://globyte.ru/cases/tbank", snippet: "Глоубайт внедрил платформу для Т-Банка", date: "12 мая 2025 г." });
  assert.deepEqual(r[1], { title: "Новость", url: "https://vc.ru/x", snippet: "Текст" });
});

test("выдача Яндекса (XML)", () => {
  const r = parseYandexXml(YA);
  assert.equal(r.length, 2);
  assert.equal(r[0].title, "Глоубайт — интегратор");
  assert.equal(r[0].snippet, "Работаем с Т-Банком с 2021 года … Проекты");
  assert.equal(r[0].date, "2026-03-12");
  assert.equal(r[1].snippet, "Т-Банк");
});

test("страница в текст: основная часть, без меню и скриптов", () => {
  const html = `<html><head><title>Кейс &laquo;Т-Банк&raquo;</title>
  <meta property="article:published_time" content="2025-05-01"><script>var x=1</script><style>.a{}</style></head>
  <body><header>Меню сайта</header><nav><a>Главная</a></nav>
  <article><h1>Как мы помогли Т-Банку</h1><p>${"Глоубайт внедрил систему. ".repeat(20)}</p><ul><li>Срок — 6 месяцев</li><li>Команда — 12 человек</li></ul></article>
  <footer>© 2026</footer></body></html>`;
  const p = htmlToText(html);
  assert.equal(p.title, "Кейс «Т-Банк»");
  assert.equal(p.date, "2025-05-01");
  assert.match(p.text, /^Как мы помогли Т-Банку/);
  assert.match(p.text, /• Срок — 6 месяцев\n• Команда — 12 человек/);
  assert.doesNotMatch(p.text, /Меню сайта|Главная|var x|©/);
});

test("внутренняя сеть закрыта", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.20.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"]) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ["8.8.8.8", "185.12.92.1", "2a00:1450::1"]) assert.ok(!isPrivateIp(ip), ip);
  const web = createWeb({}, { fetchImpl: async () => { throw new Error("не должен ходить"); }, lookup: async () => [{ address: "10.0.0.5" }] });
  await assert.rejects(web.read("http://intranet.example.com/"), /внутреннюю сеть/);
  await assert.rejects(web.read("http://localhost:3000/api"), /внутреннюю сеть/);
  await assert.rejects(web.read("file:///etc/passwd"), /http/);
});

test("порядок сервисов и запасной вариант", async () => {
  assert.deepEqual(webProviders({}), ["bing", "duckduckgo"]);
  assert.deepEqual(webProviders({ tavilyKey: "t", yandexKey: "y", yandexFolder: "f" }), ["yandex", "tavily", "bing", "duckduckgo"]);
  assert.deepEqual(webProviders({ tavilyKey: "t", braveKey: "b", provider: "brave" }), ["brave", "tavily", "bing", "duckduckgo"]);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("tavily")) return new Response("oops", { status: 500 });
    if (url.includes("bing")) return new Response("<html>пусто</html>", { status: 200 });
    return new Response(DDG, { status: 200, headers: { "content-type": "text/html" } });
  };
  const web = createWeb({ tavilyKey: "t" }, { fetchImpl });
  const r = await web.search("Глоубайт ТБанк");
  assert.equal(r.provider, "duckduckgo");
  assert.equal(r.results.length, 2);
  assert.equal(calls.length, 3);
});

test("чтение страницы: кодировка windows-1251 и обрезка", async () => {
  // перекодировать строку в cp1251 вручную: кириллица U+0410..U+044F → 0xC0..0xFF
  const src = `<html><head><meta charset="windows-1251"><title>Тест</title></head><body><p>${"Привет мир. ".repeat(2000)}</p></body></html>`;
  const bytes = Buffer.from([...src].map((ch) => { const c = ch.codePointAt(0); return c >= 0x410 && c <= 0x44f ? c - 0x410 + 0xc0 : c; }));
  const web = createWeb({}, {
    fetchImpl: async () => new Response(bytes, { status: 200, headers: { "content-type": "text/html" } }),
    lookup: async () => [{ address: "93.184.216.34" }],
  });
  const p = await web.read("https://example.ru/page");
  assert.equal(p.title, "Тест");
  assert.match(p.text, /^Привет мир\./);
  assert.ok(p.truncated);
  assert.ok(p.text.length < 9100);
});

test("инструменты: есть в обоих режимах, лимиты на поиск", async () => {
  assert.ok(toolDefs("chat").some((t) => t.function.name === "web_search"));
  assert.ok(toolDefs("job").some((t) => t.function.name === "read_page"));
  let n = 0;
  const web = { search: async (q) => ({ provider: "fake", results: [{ title: "t", url: "https://a.ru", snippet: q }] }), read: async (url) => ({ url, title: "T", text: "текст" }) };
  const run = createToolRunner({ nodes: {}, jobs: {}, outbox: {}, deps: { web }, tz: "Europe/Moscow" });
  for (let i = 0; i < 6; i++) { const r = await run("web_search", { query: "q" + i }); assert.equal(r.results[0].snippet, "q" + i); n++; }
  assert.match((await run("web_search", { query: "ещё" })).error, /Хватит/);
  assert.equal((await run("read_page", { url: "https://a.ru" })).text, "текст");
  const failing = createToolRunner({ nodes: {}, jobs: {}, outbox: {}, deps: { web: { search: async () => { throw new Error("сеть"); } } }, tz: "Europe/Moscow" });
  assert.equal((await failing("web_search", { query: "x" })).error, "сеть");
  assert.equal(n, 6);
});

test("ссылки в Telegram", () => {
  assert.equal(toHtml("Источники:\n[Кейс Т-Банк](https://globyte.ru/cases?a=1&b=2)"),
    'Источники:\n<a href="https://globyte.ru/cases?a=1&amp;b=2">Кейс Т-Банк</a>');
});
