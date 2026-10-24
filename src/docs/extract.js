// Текст из документов: PDF, Word (docx), Excel (xlsx), PowerPoint (pptx), OpenDocument (odt/ods/odp),
// обычный текст (txt, md, csv, json, xml, html…). Старые форматы (doc, xls, ppt) и картинки — без текста.
//
// Возвращает { status: "ok" | "unsupported" | "empty" | "failed", text, pages, note }.

import { unzipSync, strFromU8 } from "fflate";
import { htmlToText, decodeEntities } from "../ai/web.js";

export const MAX_TEXT = 1_000_000; // больше — не храним (MEDIUMTEXT и здравый смысл)

// pdf.js ждёт Promise.withResolvers (есть с Node 22)
if (!Promise.withResolvers) {
  Promise.withResolvers = function withResolvers() {
    let resolve, reject;
    const promise = new this((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
  };
}

const TEXT_EXT = new Set([".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".log", ".yml", ".yaml", ".ini", ".sql", ".js", ".py", ".srt", ".vtt", ".eml"]);

export function docType(name = "", mime = "") {
  const ext = (String(name).toLowerCase().match(/\.[a-z0-9]+$/) || [""])[0];
  const m = String(mime).toLowerCase();
  if (ext === ".pdf" || m === "application/pdf") return "pdf";
  if (ext === ".docx" || m.includes("wordprocessingml")) return "docx";
  if (ext === ".xlsx" || ext === ".xlsm" || m.includes("spreadsheetml")) return "xlsx";
  if (ext === ".pptx" || m.includes("presentationml")) return "pptx";
  if ([".odt", ".ods", ".odp"].includes(ext) || m.includes("opendocument")) return "odf";
  if ([".html", ".htm"].includes(ext) || m === "text/html") return "html";
  if (ext === ".rtf" || m.includes("rtf")) return "rtf";
  if (TEXT_EXT.has(ext) || m.startsWith("text/") || m === "application/json") return "text";
  if ([".doc", ".xls", ".ppt"].includes(ext) || m === "application/msword" || m === "application/vnd.ms-excel") return "legacy";
  return null;
}

export async function extractText(buf, { name = "", mime = "" } = {}) {
  const type = docType(name, mime);
  if (!type) return { status: "unsupported", text: null, note: "Из этого формата текст не достаю" };
  if (type === "legacy") return { status: "unsupported", text: null, note: "Старый формат Office (doc/xls/ppt) — пересохрани в docx/xlsx/pptx или PDF" };
  try {
    let r;
    if (type === "pdf") r = await fromPdf(buf);
    else if (type === "docx") r = fromDocx(buf);
    else if (type === "xlsx") r = fromXlsx(buf);
    else if (type === "pptx") r = fromPptx(buf);
    else if (type === "odf") r = fromOdf(buf);
    else if (type === "html") r = { text: htmlToText(decodeText(buf)).text };
    else if (type === "rtf") r = { text: fromRtf(decodeText(buf)) };
    else r = { text: decodeText(buf) };
    let text = tidy(r.text || "");
    if (!text) {
      return { status: "empty", text: null, pages: r.pages, note: type === "pdf" ? "В PDF нет текстового слоя — похоже на скан" : "Текста не нашлось" };
    }
    const cut = text.length > MAX_TEXT;
    if (cut) text = text.slice(0, MAX_TEXT);
    return { status: "ok", text, pages: r.pages ?? null, note: cut ? "Текст очень длинный — сохранено начало" : null };
  } catch (e) {
    return { status: "failed", text: null, note: `Не смогла прочитать: ${String(e.message).slice(0, 200)}` };
  }
}

async function fromPdf(buf) {
  const { getDocumentProxy, extractText: pdfText } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await pdfText(pdf, { mergePages: false });
  const parts = (Array.isArray(text) ? text : [text]).map((t, i) => (t.trim() ? `[стр. ${i + 1}]\n${t.trim()}` : "")).filter(Boolean);
  return { text: parts.join("\n\n"), pages: totalPages };
}

function unzip(buf, filter) {
  return unzipSync(new Uint8Array(buf), { filter: (f) => filter(f.name) });
}

const xmlText = (s) => decodeEntities(s.replace(/<[^>]+>/g, ""));

function fromDocx(buf) {
  const files = unzip(buf, (n) => /^word\/(document|footnotes|endnotes)\.xml$/.test(n) || /^word\/(header|footer)\d*\.xml$/.test(n));
  const doc = files["word/document.xml"];
  if (!doc) throw new Error("это не docx");
  const paras = (x) => x.split(/<\/w:p>/).map((p) => xmlText(p).trim()).filter(Boolean);
  const para = (xml) => paras(strFromU8(xml)
    .replace(/<w:tab\/>/g, "\t").replace(/<w:br[^>]*\/>/g, "\n")
    // строка таблицы — одной строкой: «ячейка | ячейка»
    .replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, (row) => (row.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) || []).map((c) => paras(c).join(" ")).join(" | ") + "</w:p>"))
    .join("\n");
  const extra = Object.keys(files).filter((n) => n !== "word/document.xml").map((n) => para(files[n])).filter(Boolean);
  return { text: [para(doc), ...extra].join("\n\n") };
}

function fromXlsx(buf) {
  const files = unzip(buf, (n) => n === "xl/sharedStrings.xml" || n === "xl/workbook.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n) || n === "xl/_rels/workbook.xml.rels");
  const shared = [];
  if (files["xl/sharedStrings.xml"]) {
    for (const si of strFromU8(files["xl/sharedStrings.xml"]).match(/<si>[\s\S]*?<\/si>/g) || []) {
      shared.push(xmlText((si.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).join("")));
    }
  }
  // имена листов по порядку
  const wb = files["xl/workbook.xml"] ? strFromU8(files["xl/workbook.xml"]) : "";
  const rels = files["xl/_rels/workbook.xml.rels"] ? strFromU8(files["xl/_rels/workbook.xml.rels"]) : "";
  const relTarget = {};
  const attr = (tag, a) => (tag.match(new RegExp(`\\b${a}="([^"]*)"`)) || [])[1];
  for (const [tag] of rels.matchAll(/<Relationship\b[^>]*>/g)) relTarget[attr(tag, "Id")] = String(attr(tag, "Target") || "").replace(/^\/?xl\//, "");
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map(([tag]) => ({ name: decodeEntities(attr(tag, "name") || ""), file: "xl/" + (relTarget[attr(tag, "r:id")] || "") }));
  const list = sheets.length ? sheets : Object.keys(files).filter((n) => n.startsWith("xl/worksheets/")).sort().map((f, i) => ({ name: `Лист ${i + 1}`, file: f }));
  const out = [];
  let rowsTotal = 0;
  for (const sh of list) {
    const xml = files[sh.file] ? strFromU8(files[sh.file]) : "";
    const rows = [];
    for (const row of xml.match(/<row\b[\s\S]*?<\/row>/g) || []) {
      if (rowsTotal++ > 20000) break;
      const cells = [];
      for (const c of row.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
        const t = (c.match(/\bt="(\w+)"/) || [])[1];
        const v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = "";
        if (t === "s" && v !== undefined) val = shared[+v] ?? "";
        else if (t === "inlineStr") val = xmlText((c.match(/<is>[\s\S]*?<\/is>/) || [""])[0]);
        else if (v !== undefined) val = decodeEntities(v);
        cells.push(val.replace(/\s+/g, " ").trim());
      }
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      if (cells.length) rows.push(cells.join("\t"));
    }
    if (rows.length) out.push(`[лист «${sh.name}»]\n${rows.join("\n")}`);
  }
  return { text: out.join("\n\n"), pages: list.length };
}

function fromPptx(buf) {
  const files = unzip(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n) || /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n));
  const num = (n) => +(n.match(/(\d+)\.xml$/) || [0, 0])[1];
  const slides = Object.keys(files).filter((n) => n.startsWith("ppt/slides/")).sort((a, b) => num(a) - num(b));
  const out = slides.map((n) => {
    const paras = strFromU8(files[n]).split(/<\/a:p>/).map((p) => xmlText((p.match(/<a:t>[\s\S]*?<\/a:t>/g) || []).join("")).trim()).filter(Boolean);
    const notes = files[`ppt/notesSlides/notesSlide${num(n)}.xml`];
    const nt = notes ? xmlText((strFromU8(notes).match(/<a:t>[\s\S]*?<\/a:t>/g) || []).join(" ")).trim() : "";
    return `[слайд ${num(n)}]\n${paras.join("\n")}${nt && !/^\d+$/.test(nt) ? `\nЗаметки: ${nt}` : ""}`;
  });
  return { text: out.join("\n\n"), pages: slides.length };
}

function fromOdf(buf) {
  const files = unzip(buf, (n) => n === "content.xml");
  if (!files["content.xml"]) throw new Error("это не OpenDocument");
  const cellText = (c) => xmlText(c.replace(/<\/text:(p|h)>/g, " ")).replace(/\s+/g, " ").trim();
  const xml = strFromU8(files["content.xml"])
    .replace(/<text:tab\/>/g, "\t").replace(/<text:line-break\/>/g, "\n")
    .replace(/<table:table-row\b[\s\S]*?<\/table:table-row>/g, (row) => {
      const cells = (row.match(/<table:table-cell\b[^>]*?(?:\/>|>[\s\S]*?<\/table:table-cell>)/g) || []).map(cellText);
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      return cells.length ? cells.join(" | ") + "\n" : "";
    })
    .replace(/<\/text:(p|h)>/g, "\n");
  return { text: xmlText(xml) };
}

function fromRtf(s) {
  return s.replace(/\\par[d]?/g, "\n").replace(/\\'([0-9a-f]{2})/gi, (m, h) => {
    return new TextDecoder("windows-1251").decode(new Uint8Array([parseInt(h, 16)]));
  }).replace(/\\u(-?\d+)\??/g, (m, n) => String.fromCharCode(n < 0 ? 65536 + +n : +n))
    .replace(/\{\\\*[^{}]*\}/g, "").replace(/\\[a-z]+-?\d* ?/gi, "").replace(/[{}]/g, "");
}

export function decodeText(buf) {
  const b = Buffer.from(buf);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString("utf8");
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  const utf = new TextDecoder("utf-8", { fatal: true });
  try { return utf.decode(b); } catch { return new TextDecoder("windows-1251").decode(b); }
}

function tidy(s) {
  return String(s).replace(/\r\n?/g, "\n").replace(/[ \t ]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").replace(/\u0000/g, "").trim();
}
