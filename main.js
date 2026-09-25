/**
 * ReportIt — assemble chosen workspace objects into one uniform report and
 * print it to PDF.
 *
 * The plugin never edits a source object. It reads their titles and `content`
 * (markdown), lays them out as a coherent document — cover, table of contents,
 * one section per object, consistent typography — and prints it. Output is a
 * PDF via `window.print()`; nothing is written back to the workspace.
 *
 * Split:
 *   - PURE FUNCTIONS operate on a plain-object AST and are exported by name so
 *     `self-check.mjs` can run them under plain node with no DOM.
 *   - the DOM LAYER turns the AST into elements with `createElement` /
 *     `textContent` — never a markup string (`self-check` greps for the
 *     markup-assigning properties). Titles and bodies are untrusted text: they
 *     arrive by sync and import.
 *
 * One ES module, no build step, no dependencies, no network.
 */

// ------------------------------------------------------------ the markdown AST
//
// Block =
//   | { kind: "heading", level: 1..6, inline: Inline[] }
//   | { kind: "para", inline: Inline[] }
//   | { kind: "list", ordered: boolean, items: ListItem[] }
//   | { kind: "code", text: string, lang?: string }
//   | { kind: "quote", blocks: Block[] }
//   | { kind: "hr" }
//   | { kind: "image", src: string, alt: string }
// ListItem = { inline: Inline[], checked: boolean | null }
// Inline =
//   | { kind: "text" | "strong" | "em" | "code" | "hl", text: string }

/** `media/<uuid-v4>.<ext>` with an extension we can turn into a data: URI.
 *  Deliberately NOT `svg` — it carries script, and `context.data.media.read`
 *  refuses it too. */
const MEDIA_REF = /^media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|gif|webp|bmp)$/;

const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
};

/** The MIME type for a `media/<uuid>.<ext>` filename. Throws on an unknown
 *  extension: `mediaRefsIn` only ever yields the known set, so anything else
 *  reaching here is a bug, not input to tolerate. */
export function mimeForExt(name) {
  const ext = String(name).toLowerCase().split(".").pop();
  const mime = MIME[ext];
  if (!mime) throw new Error(`no MIME type for extension: ${ext}`);
  return mime;
}

/** Split inline markdown into typed spans. Links and wikilinks are reduced to
 *  their visible text — this is a client report, not a hyperdocument. A
 *  mid-line `![alt](src)` also reduces to `alt`; a standalone image line is a
 *  block, handled in `renderMarkdown`. */
export function parseInline(text) {
  const out = [];
  let rest = String(text ?? "");
  // Order matters: images before links (they share `[...](...)`), code before
  // emphasis (a `*` inside backticks is literal).
  // `guard(m, prev)` gets the match and the char just before it. Underscore
  // emphasis is refused mid-word (`SET_LD_TO_PLANNED` must stay literal);
  // asterisk emphasis has no such restriction, matching CommonMark.
  const wordChar = (c) => /[0-9A-Za-z]/.test(c || "");
  const notIntraword = (m, prev, after) => {
    const delim = m[1];
    if (delim !== "_" && delim !== "__") return true;
    return !wordChar(prev) && !wordChar(after);
  };
  const rules = [
    [/^!\[([^\]]*)\]\([^)]*\)/, (m) => ({ kind: "text", text: m[1] })],
    [/^\[\[([^\]]+)\]\]/, (m) => ({ kind: "text", text: m[1] })],
    [/^\[([^\]]*)\]\([^)]*\)/, (m) => ({ kind: "text", text: m[1] })],
    [/^`([^`]+)`/, (m) => ({ kind: "code", text: m[1] })],
    [/^==([^=]+)==/, (m) => ({ kind: "hl", text: m[1] })],
    [/^(\*\*|__)(.+?)\1/, (m) => ({ kind: "strong", text: m[2] }), notIntraword],
    [/^(\*|_)(?!\s)(.+?)(?<!\s)\1/, (m) => ({ kind: "em", text: m[2] }), notIntraword],
  ];
  let buffer = "";
  const flush = () => { if (buffer) { out.push({ kind: "text", text: buffer }); buffer = ""; } };
  while (rest) {
    let matched = null;
    const prev = buffer ? buffer[buffer.length - 1] : "";
    for (const [re, make, guard] of rules) {
      const m = rest.match(re);
      if (m && (!guard || guard(m, prev, rest[m[0].length] || ""))) {
        matched = { node: make(m), length: m[0].length };
        break;
      }
    }
    if (matched) {
      flush();
      out.push(matched.node);
      rest = rest.slice(matched.length);
    } else {
      buffer += rest[0];
      rest = rest.slice(1);
    }
  }
  flush();
  return out.length ? out : [{ kind: "text", text: "" }];
}

// A note's `content` is usually plain Markdown, but a note untouched since
// before Core's Markdown editor still holds a Tiptap/ProseMirror
// `{"type":"doc",...}` document (migration 028 converts these, but an
// unmigrated install, or an import, can still carry one). Left as-is, our
// parser dumps the raw JSON as one paragraph. This flattens it to the same
// Markdown text `textFromDocument` in Core produces, so both dialects feed
// one rendering path. Ported from `markdownFromNode` / `markdownInline` in
// src/core/app/CoreOnlyApp.tsx.
const MARK_DELIM = { bold: "**", strong: "**", italic: "*", em: "*", underline: "__", u: "__", strike: "~~", s: "~~", del: "~~", highlight: "==", mark: "==" };
const MARK_ORDER = ["**", "__", "~~", "==", "*"];

function inlineFromNode(node) {
  if (!node || typeof node !== "object") return "";
  if (node.type === "hardBreak") return "\n";
  if (typeof node.text !== "string") return "";
  const delims = new Set();
  for (const mark of Array.isArray(node.marks) ? node.marks : []) {
    const d = mark && typeof mark === "object" ? MARK_DELIM[mark.type] : undefined;
    if (d) delims.add(d);
  }
  return MARK_ORDER.filter((d) => delims.has(d)).reduce((t, d) => `${d}${t}${d}`, node.text);
}
const inlineChildren = (node) => (Array.isArray(node?.content) ? node.content.map(inlineFromNode).join("") : "");

function nodeToMarkdown(node, listCtx = null, indexInList = 0) {
  if (!node || typeof node !== "object") return "";
  const attrs = node.attrs ?? {};
  switch (node.type) {
    case "text": return inlineFromNode(node);
    case "paragraph": return inlineChildren(node);
    case "heading": return `${"#".repeat(Math.min(6, Math.max(1, Number(attrs.level) || 1)))} ${inlineChildren(node)}`;
    case "codeBlock": {
      const lang = typeof attrs.language === "string" ? attrs.language : "";
      const code = (node.content ?? []).map((c) => (c && typeof c === "object" ? c.text ?? "" : "")).join("");
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    }
    case "image": return `![${typeof attrs.alt === "string" ? attrs.alt : ""}](${typeof attrs.src === "string" ? attrs.src : ""})`;
    case "horizontalRule": return "---";
    case "blockquote": return (node.content ?? []).map((c) => nodeToMarkdown(c)).join("\n").split("\n").map((l) => `> ${l}`).join("\n");
    case "bulletList": return (node.content ?? []).map((c, k) => nodeToMarkdown(c, { ordered: false, start: 1 }, k)).join("\n");
    case "orderedList": { const start = Number(attrs.start) || 1; return (node.content ?? []).map((c, k) => nodeToMarkdown(c, { ordered: true, start }, k)).join("\n"); }
    case "taskList": return (node.content ?? []).map((c) => nodeToMarkdown(c)).join("\n");
    case "listItem": {
      const inner = (node.content ?? []).map((c) => nodeToMarkdown(c)).join(" ").trim();
      return `${listCtx?.ordered ? `${listCtx.start + indexInList}. ` : "- "}${inner}`;
    }
    case "taskItem": {
      const inner = (node.content ?? []).map((c) => nodeToMarkdown(c)).join(" ").trim();
      return `- [${attrs.checked === true ? "x" : " "}] ${inner}`;
    }
    default: return (node.content ?? []).map((c) => nodeToMarkdown(c)).join("\n");
  }
}

/** Tiptap-shaped `{"type":"doc",...}` JSON → Markdown text. Any other string
 *  (already Markdown, or not JSON at all) is returned unchanged. */
export function tiptapToMarkdown(raw) {
  const str = String(raw ?? "");
  if (!str.trimStart().startsWith("{")) return str;
  let doc;
  try { doc = JSON.parse(str); } catch { return str; }
  if (!doc || doc.type !== "doc" || !Array.isArray(doc.content)) return str;
  return doc.content.map((node) => nodeToMarkdown(node)).join("\n").trimEnd();
}

/**
 * A note can carry an image in the middle of a line: "step 3 text![](media/…)",
 * typed or pasted after text (older notes and synced ones do). Left in the line,
 * the inline parser reduces it to its (empty) alt text and the screenshot
 * vanishes from the report. Give every such image a line of its own, keeping the
 * text before and after it. Fenced code and quotes (which recurse) are left alone.
 */
const INLINE_MEDIA_IMAGE = /!\[[^\]]*\]\(media\/[^)\s]+(?:\s+"[^"]*")?\)/g;
export function splitInlineImages(lines) {
  const out = [];
  let fence = null;
  for (const line of lines) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) { fence = fence === null ? marker[1][0] : fence === marker[1][0] ? null : fence; out.push(line); continue; }
    if (fence !== null || /^\s*>/.test(line) || !line.includes("![")) { out.push(line); continue; }
    let last = 0;
    for (const m of line.matchAll(INLINE_MEDIA_IMAGE)) {
      const before = line.slice(last, m.index);
      if (before.trim()) out.push(before.trimEnd());
      out.push(m[0]);
      last = m.index + m[0].length;
    }
    if (last === 0) out.push(line);
    else if (line.slice(last).trim()) out.push(line.slice(last).trim());
  }
  return out;
}

/** One markdown string → Block[]. Minimal by design: the constructs a note
 *  actually carries, everything else degrading to paragraph text rather than
 *  throwing. */
export function renderMarkdown(md) {
  const lines = splitInlineImages(String(md ?? "").replace(/\r\n?/g, "\n").split("\n"));
  const blocks = [];
  let i = 0;

  const isBlank = (s) => s.trim() === "";
  const listMatch = (s) => s.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
  // Cells split on unescaped pipes; the outer pipes are optional.
  const cellsOf = (s) => s.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
  const tableStart = (k) => lines[k].includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[k + 1] ?? "") && (lines[k + 1] ?? "").includes("|");

  while (i < lines.length) {
    let line = lines[i];

    if (isBlank(line)) { i += 1; continue; }

    // fenced code
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1][0];
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence (or EOF)
      const lang = line.trim().slice(fence[1].length).trim().split(/\s+/)[0].toLowerCase();
      blocks.push({ kind: "code", text: body.join("\n"), ...(lang ? { lang } : {}) });
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ kind: "hr" }); i += 1; continue; }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { blocks.push({ kind: "heading", level: h[1].length, inline: parseInline(h[2]) }); i += 1; continue; }

    // standalone image
    const img = line.trim().match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/);
    if (img) { blocks.push({ kind: "image", src: img[2], alt: img[1] }); i += 1; continue; }

    // blockquote — consume the run, strip one `>` per line, recurse
    if (/^\s*>\s?/.test(line)) {
      const inner = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        inner.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "quote", blocks: renderMarkdown(inner.join("\n")) });
      continue;
    }

    // GFM table — a header row, a `| --- |` separator, then body rows
    if (tableStart(i)) {
      const align = cellsOf(lines[i + 1]).map((c) => c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : "left");
      const head = cellsOf(line);
      i += 2;
      const rows = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) {
        const cells = cellsOf(lines[i]);
        rows.push(head.map((_, c) => parseInline(cells[c] ?? "")));
        i += 1;
      }
      blocks.push({ kind: "table", align: head.map((_, c) => align[c] ?? "left"), head: head.map((c) => parseInline(c)), rows });
      continue;
    }

    // list — consume the run; nesting by indent (one level deep is enough for
    // a note; deeper indent items are folded into the nearest list)
    if (listMatch(line)) {
      const first = listMatch(line);
      const ordered = /\d+\./.test(first[2]);
      const items = [];
      while (i < lines.length) {
        const m = listMatch(lines[i]);
        if (!m) {
          // a plain continuation line under the current item
          if (items.length && !isBlank(lines[i]) && /^\s+\S/.test(lines[i])) {
            const cont = parseInline(lines[i].trim());
            items[items.length - 1].inline.push({ kind: "text", text: " " }, ...cont);
            i += 1;
            continue;
          }
          break;
        }
        let content = m[3];
        let checked = null;
        const task = content.match(/^\[([ xX])\]\s+(.*)$/);
        if (task) { checked = task[1].toLowerCase() === "x"; content = task[2]; }
        items.push({ inline: parseInline(content), checked });
        i += 1;
      }
      blocks.push({ kind: "list", ordered, items, start: ordered ? Number.parseInt(first[2], 10) || 1 : 1 });
      continue;
    }

    // paragraph — gather until a blank line, the start of another block, or a
    // line that is entirely an image (Notible stores `![](media/…)` with no
    // blank line around it, and we want it as its own block, not swallowed
    // into the paragraph and reduced to alt text).
    const standaloneImage = (s) => /^!\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\)$/.test(s.trim());
    const startsBlock = (s) => isBlank(s) || /^(#{1,6}\s|\s*>|\s*(`{3,}|~{3,}))/.test(s) || !!listMatch(s) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(s) || standaloneImage(s);
    const para = [];
    while (i < lines.length && !startsBlock(lines[i]) && !tableStart(i)) {
      para.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ kind: "para", inline: parseInline(para.join(" ")) });
  }

  return blocks;
}

/** Push every heading down by `offset` levels, flattening anything past h6.
 *  One pass, no sequential double-mapping. Report `<h1>` is the report title,
 *  `<h2>` a section title, so note content starts at `<h3>` (offset 2). */
export function normalizeHeadings(blocks, offset = 2) {
  return blocks.map((block) => {
    if (block.kind === "heading") {
      return { ...block, level: Math.min(6, block.level + offset) };
    }
    if (block.kind === "quote") {
      return { ...block, blocks: normalizeHeadings(block.blocks, offset) };
    }
    return block;
  });
}

/** Every distinct embeddable `media/<uuid>.<ext>` reference in the tree.
 *  SVG and non-`media/` srcs are excluded — the DOM layer renders those as a
 *  placeholder, they are never read. */
export function mediaRefsIn(blocks) {
  const seen = new Set();
  const walk = (list) => {
    for (const block of list) {
      if (block.kind === "image" && MEDIA_REF.test(block.src)) seen.add(block.src);
      else if (block.kind === "quote") walk(block.blocks);
    }
  };
  walk(Array.isArray(blocks) ? blocks : []);
  return [...seen];
}

/** Every distinct ```mermaid source in the tree, to draw before layout. */
export function diagramSourcesIn(blocks) {
  const seen = new Set();
  const walk = (list) => {
    for (const block of list) {
      if (block.kind === "code" && block.lang === "mermaid" && block.text.trim()) seen.add(block.text);
      else if (block.kind === "quote") walk(block.blocks);
    }
  };
  walk(Array.isArray(blocks) ? blocks : []);
  return [...seen];
}

/** The table of contents is section titles, in order — no page numbers (the
 *  print engine cannot tell us where pages land). */
export function buildTocModel(sectionTitles) {
  return (Array.isArray(sectionTitles) ? sectionTitles : []).map((title) => String(title ?? "Untitled"));
}

/** The whole report as a plain object the DOM layer renders. Not a string,
 *  not DOM — serialisable, so the node test can assert on it. */
export function reportModel({ title, description, dateText, sections, footer, coverLogos }) {
  const list = Array.isArray(sections) ? sections : [];
  const normalized = list.map((s) => ({
    title: String(s.title ?? "").trim() || "Untitled",
    type: String(s.type ?? ""),
    blocks: Array.isArray(s.blocks) ? s.blocks : [],
    properties: (Array.isArray(s.properties) ? s.properties : [])
      .map((p) => ({ label: String(p?.label ?? "").trim(), value: String(p?.value ?? "").trim() }))
      .filter((p) => p.label && p.value),
  }));
  const f = footer && typeof footer === "object" ? footer : {};
  return {
    cover: {
      title: String(title ?? "").trim() || "Report",
      dateText: String(dateText ?? ""),
      description: String(description ?? "").trim(),
      logos: (Array.isArray(coverLogos) ? coverLogos : []).slice(0, 2).filter((uri) => /^data:image\/(png|jpeg|webp|gif);base64,/i.test(uri)),
    },
    toc: buildTocModel(normalized.map((s) => s.title)),
    sections: normalized,
    // Optional running footer (repeats on every printed page): a short note
    // ("Confidential") and/or a small logo. `logoUri` must be a data: image —
    // it is read from a local file client-side, never a remote URL.
    footer: {
      note: String(f.note ?? "").trim(),
      logoUri: typeof f.logoUri === "string" && f.logoUri.startsWith("data:image/") ? f.logoUri : "",
      align: f.align === "left" ? "left" : "right",
      pageNumbers: f.pageNumbers === true,
    },
  };
}

// ---------------------------------------------------------------- the DOM layer


function el(tag, props = {}, kids = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const kid of kids) node.append(kid);
  return node;
}

function textNode(value) {
  return document.createTextNode(String(value ?? ""));
}

function renderInline(inline) {
  const frag = document.createDocumentFragment();
  for (const span of Array.isArray(inline) ? inline : []) {
    if (span.kind === "text") { frag.append(textNode(span.text)); continue; }
    const tag = span.kind === "strong" ? "strong" : span.kind === "em" ? "em" : span.kind === "code" ? "code" : "mark";
    const node = document.createElement(tag);
    if (span.kind === "hl") node.className = "rp-hl";
    node.textContent = String(span.text ?? "");
    frag.append(node);
  }
  return frag;
}

/**
 * `blocks` → a DocumentFragment. `dataUris` maps a `media/<uuid>.<ext>` ref to
 * a `data:` URL; a ref with no entry (missing, read refused), an SVG ref, or a
 * non-`media/` src all render as a small placeholder line rather than a broken
 * `<img>`.
 */
function renderBlocks(blocks, dataUris) {
  const frag = document.createDocumentFragment();
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block.kind === "heading") {
      const h = document.createElement(`h${Math.min(6, Math.max(1, block.level || 3))}`);
      h.append(renderInline(block.inline));
      frag.append(h);
    } else if (block.kind === "para") {
      const p = document.createElement("p");
      p.append(renderInline(block.inline));
      frag.append(p);
    } else if (block.kind === "list") {
      const listEl = document.createElement(block.ordered ? "ol" : "ul");
      // A list split by a screenshot continues its numbering instead of restarting at 1.
      if (block.ordered && block.start > 1) listEl.start = block.start;
      for (const item of block.items ?? []) {
        const li = document.createElement("li");
        if (item.checked !== null && item.checked !== undefined) {
          li.className = "rp-task";
          const box = el("span", { className: "rp-check" });
          box.dataset.on = item.checked ? "yes" : "no";
          box.setAttribute("aria-hidden", "true");
          li.append(box);
        }
        li.append(renderInline(item.inline));
        listEl.append(li);
      }
      frag.append(listEl);
    } else if (block.kind === "code" && dataUris?.get?.(DIAGRAM_KEY + block.text)) {
      // Drawn by Core before layout (see drawDiagrams). As an <img>, never
      // parsed into the page: nothing inside the SVG can run.
      const svg = dataUris.get(DIAGRAM_KEY + block.text);
      const img = el("img", { className: "rp-diagram", alt: "Diagram" });
      const width = Number(svg.match(/viewBox="[\d.-]+ [\d.-]+ ([\d.]+) /)?.[1]);
      if (width > 0) img.style.width = `${width}px`;
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      frag.append(img);
    } else if (block.kind === "code") {
      const pre = document.createElement("pre");
      pre.textContent = String(block.text ?? "");
      frag.append(pre);
    } else if (block.kind === "quote") {
      const bq = document.createElement("blockquote");
      bq.append(renderBlocks(block.blocks, dataUris));
      frag.append(bq);
    } else if (block.kind === "table") {
      const row = (cells, tag) => el("tr", {}, cells.map((inline, c) => {
        const cell = el(tag, {}, [renderInline(inline)]);
        if (block.align?.[c] && block.align[c] !== "left") cell.style.textAlign = block.align[c];
        return cell;
      }));
      frag.append(el("table", { className: "rp-table" }, [
        el("thead", {}, [row(block.head ?? [], "th")]),
        el("tbody", {}, (block.rows ?? []).map((cells) => row(cells, "td"))),
      ]));
    } else if (block.kind === "hr") {
      frag.append(document.createElement("hr"));
    } else if (block.kind === "image") {
      const uri = dataUris && dataUris.get ? dataUris.get(block.src) : null;
      if (uri) {
        const img = el("img", { className: "rp-img", alt: String(block.alt ?? "") });
        img.src = uri;
        frag.append(img);
      } else {
        const isExternal = /^[a-z][a-z0-9+.-]*:\/\//i.test(String(block.src)) || String(block.src).includes("/");
        const p = el("p", { className: "rp-img-missing" });
        p.textContent = MEDIA_REF.test(String(block.src))
          ? `[image unavailable: ${block.alt || "unnamed"}]`
          : isExternal
            ? `[external image: ${block.alt || block.src}]`
            : `[image unavailable: ${block.alt || "unnamed"}]`;
        frag.append(p);
      }
    }
  }
  return frag;
}

/** `dataUris` also carries drawn diagrams, keyed by this prefix + source. */
const DIAGRAM_KEY = "diagram:";

/** Mermaid's markup is HTML-flavoured: a label with a line break carries an
 *  unclosed `<br>`, which an <img> (strict XML) refuses, so the picture came
 *  out broken. Parse it as HTML (DOMParser never runs scripts) and write it
 *  back as XML. Core 0.91.1+ already returns XML; this keeps 0.91.0 working. */
export function asXml(svg) {
  const node = new DOMParser().parseFromString(svg, "text/html").body.querySelector("svg");
  return node ? new XMLSerializer().serializeToString(node) : svg;
}

/** Mermaid blocks drawn as SVG by Core (API 1.20). An older Core, or a diagram
 *  that fails to draw, leaves the block as its source code. */
async function drawDiagrams(context, sections, uris) {
  const draw = context.editor?.renderCodeBlockSvg;
  if (typeof draw !== "function") return;
  for (const source of new Set(sections.flatMap((s) => diagramSourcesIn(s.blocks)))) {
    try {
      const svg = await draw("mermaid", source, { mode: "paper" });
      if (svg) uris.set(DIAGRAM_KEY + source, asXml(svg));
    } catch { /* syntax error: print the source instead */ }
  }
}

/** The model + resolved image data URIs → the `<article class="rp-doc">`. */
async function renderReport(model, dataUris, measurementHost) {
  const doc = el("article", { className: "rp-doc" });
  // Measure the very same fixed-size sheets that will be printed. Never put
  // overflow:hidden on a sheet: an impossible layout must fail, not lose text.
  const measure = el("div", { className: "reportit-measure", ariaHidden: "true" }, [doc]);
  measurementHost.append(measure);
  const pages = [];
  let content;
  const newPage = (kind) => {
    const continuedContents = kind === "contents" && pages.some((page) => page.dataset.kind === "contents");
    const page = el("section", { className: "rp-page" });
    page.dataset.kind = kind;
    content = el("div", { className: "rp-page-content rp-body" });
    page.append(content);
    doc.append(page);
    pages.push(page);
    if (continuedContents) content.append(el("h2", { className: "rp-toc-title", textContent: "Contents · continued" }));
    return content;
  };
  const fits = () => content.scrollHeight <= content.clientHeight + 1;
  const place = (node) => { content.append(node); const ok = fits(); if (!ok) node.remove(); return ok; };
  const textPoint = (node, offset) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
      if (offset <= text.length) return [text, offset];
      offset -= text.length;
    }
    return [node, node.childNodes.length];
  };
  const piece = (node, start, end) => {
    const range = document.createRange();
    range.setStart(...textPoint(node, start));
    range.setEnd(...textPoint(node, end));
    const clone = node.cloneNode(false);
    clone.append(range.cloneContents());
    return clone;
  };
  // Split only oversized text blocks, preserving inline marks with DOM ranges.
  // Whole ordinary paragraphs move to the next sheet; long paragraphs/code can
  // continue across sheets without a clipping boundary or a fixed footer overlap.
  const flow = (node, kind = "case") => {
    if (place(node)) return;
    if (content.childNodes.length) {
      const previous = content;
      newPage(kind);
      if (place(node)) return;
      // An oversized block must use the remaining space after its heading,
      // not strand that heading on an otherwise empty sheet.
      pages.pop().remove();
      content = previous;
    }
    const full = node.textContent || "";
    if (!full.length) throw new Error("An image or block cannot fit on an A4 page.");
    let start = 0;
    while (start < full.length) {
      let low = start + 1, high = full.length, best = start;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const test = piece(node, start, middle);
        if (place(test)) { test.remove(); best = middle; low = middle + 1; }
        else high = middle - 1;
      }
      if (best === start && content.childNodes.length) { newPage(kind); continue; }
      if (best === start) throw new Error("This block cannot fit safely on an A4 page.");
      if (best < full.length) {
        // Leave a little room for a clean continuation instead of splitting a word.
        const prefix = full.slice(start, best);
        const boundary = Math.max(prefix.lastIndexOf(" "), prefix.lastIndexOf("\n"));
        if (boundary > prefix.length * .65) best = start + boundary + 1;
        if (best > start && /[\uD800-\uDBFF]/.test(full[best - 1])) best -= 1;
      }
      content.append(piece(node, start, best));
      start = best;
      if (start < full.length) newPage(kind);
    }
  };
  try {
  await document.fonts.ready;
  newPage("cover");
  const cover = el("header", { className: "rp-cover" });
  if (model.cover.logos.length) {
    const logos = el("div", { className: "rp-cover-logos" });
    for (const [index, uri] of model.cover.logos.entries()) logos.append(el("img", { src: uri, alt: index ? "Client logo" : "Company logo" }));
    cover.append(logos);
  }
  cover.append(el("p", { className: "rp-cover-eyebrow", textContent: "REPORT" }),
    el("h1", { className: "rp-title", textContent: model.cover.title }),
    el("p", { className: "rp-date", textContent: model.cover.dateText }));
  if (model.cover.description) {
    cover.append(el("p", { className: "rp-desc", textContent: model.cover.description }));
  }
  content.append(cover);
  await Promise.all([...cover.querySelectorAll("img")].map((img) => img.decode().catch(() => {})));
  if (!fits()) throw new Error("The cover is too long. Shorten the report title or description.");

  newPage("contents");
  content.append(el("h2", { className: "rp-toc-title", textContent: "Contents" }));
  for (const [index, title] of model.toc.entries()) {
    // An in-document link, not a URL — Chromium's print-to-PDF keeps a
    // same-document `href="#id"` as a clickable internal link in the
    // resulting PDF when the target element carries a matching `id`
    // (set on each section's heading below), so this costs nothing extra
    // at print time.
    const row = el("a", { className: "rp-toc-entry", href: `#rp-section-${index}` }, [
      el("span", { className: "rp-toc-number", textContent: String(index + 1).padStart(2, "0") }),
      el("span", { textContent: title }),
    ]);
    const before = pages.length;
    flow(row, "contents");
    if (pages.length > before) content.dataset.continued = "contents";
  }

  for (const [index, section] of model.sections.entries()) {
    // Every case starts at the same safe top margin on a fresh sheet, including
    // the first one after a potentially multi-page table of contents.
    newPage("case");
    const heading = el("header", { className: "rp-section-head", id: `rp-section-${index}` }, [
      el("h2", { className: "rp-section-title", textContent: section.title }),
    ]);
    if (section.type) heading.append(el("p", { className: "rp-section-type", textContent: section.type }));
    if (section.properties.length) {
      const propsList = el("dl", { className: "rp-section-props" });
      for (const p of section.properties) {
        propsList.append(el("dt", { textContent: p.label }), el("dd", { textContent: p.value }));
      }
      heading.append(propsList);
    }
    flow(heading);
    const blocks = [...renderBlocks(section.blocks, dataUris).childNodes];
    const flowBlock = (block) => {
      if (block.tagName === "BLOCKQUOTE") {
        for (const child of [...block.children]) {
          const quote = block.cloneNode(false); quote.append(child); flow(quote);
        }
      } else if (block.tagName === "OL" || block.tagName === "UL") {
        for (const [itemIndex, item] of [...block.children].entries()) {
          const list = block.cloneNode(false);
          if (block.tagName === "OL") list.start = (block.start || 1) + itemIndex;
          list.append(item); flow(list);
        }
      } else if (block.classList?.contains("rp-diagram")) {
        // A picture, not text: never split; CSS caps its height to one sheet.
        if (!place(block)) { newPage("case"); content.append(block); }
      } else if (block.tagName === "TABLE" && block.tBodies[0]?.rows.length) {
        // Row by row; a table that runs onto the next sheet repeats its header there.
        const fresh = () => el("table", { className: block.className }, [block.tHead.cloneNode(true), document.createElement("tbody")]);
        let table = null;
        for (const row of [...block.tBodies[0].rows]) {
          if (table) { table.tBodies[0].append(row); if (fits()) continue; row.remove(); }
          table = fresh();
          table.tBodies[0].append(row);
          // ponytail: a single row taller than a sheet is not split; it overflows that sheet.
          if (!place(table)) { newPage("case"); content.append(table); }
        }
      } else flow(block);
    };
    for (const [index, block] of blocks.entries()) {
      if (block.tagName === "IMG") await block.decode().catch(() => {});
      // Keep subsection headings with a useful first line of the following block.
      if (/^H[1-6]$/.test(block.tagName) && blocks[index + 1]) {
        const probe = blocks[index + 1].cloneNode(true);
        probe.style.maxHeight = "18mm";
        probe.style.overflow = "hidden";
        content.append(block, probe);
        const together = fits();
        block.remove(); probe.remove();
        if (!together && content.childNodes.length) newPage("case");
      }
      flowBlock(block);
    }
  }

  const footer = model.footer ?? { note: "", logoUri: "" };
  for (const [index, page] of pages.entries()) {
    if (!footer.note && !footer.logoUri && !footer.pageNumbers) continue;
    const foot = el("footer", { className: "rp-footer" });
    foot.dataset.align = footer.align;
    const branding = el("div", { className: "rp-footer-branding" });
    if (footer.logoUri) {
      const logo = el("img", { className: "rp-footer-logo", alt: "" });
      logo.src = footer.logoUri;
      branding.append(logo);
    }
    if (footer.note) branding.append(el("span", { className: "rp-footer-note", textContent: footer.note }));
    foot.append(branding);
    if (footer.pageNumbers) foot.append(el("span", { className: "rp-page-number", textContent: `${index + 1} / ${pages.length}` }));
    page.append(foot);
  }
  await Promise.all([...doc.querySelectorAll("img")].map((img) => img.decode().catch(() => {})));
  for (const page of pages) {
    const body = page.querySelector(".rp-page-content");
    const foot = page.querySelector(".rp-footer");
    if (body.scrollHeight > body.clientHeight + 1 || (foot && foot.getBoundingClientRect().top < body.getBoundingClientRect().bottom + 8)) {
      throw new Error("The footer is too tall. Use a shorter footer note or a smaller logo.");
    }
  }
  doc.remove();
  return doc;
  } finally { measure.remove(); }
}

// ------------------------------------------------------------- image loading

const IMAGE_BUDGET_BYTES = 48 * 1024 * 1024; // base64 total
const IMAGE_CONCURRENCY = 4;

/** In-memory only. Re-opening the ReportIt view within one app session brings
 *  back the last title / description / filters / selection; an app restart
 *  clears it. Deliberately not the plugin storage API — this plugin writes
 *  nothing and persists nothing across sessions (see self-check). */
let builderMemory = null;

/**
 * Read the referenced images with a small fixed concurrency, stopping once the
 * running base64 total passes the budget. Returns `{ uris, missing, budget }`:
 * a `Map<ref, dataUri>`, the count that could not be read, and whether the
 * budget was hit. `alive()` lets the caller abort on dispose.
 */
async function loadImages(context, refs, onProgress, alive) {
  const uris = new Map();
  let missing = 0;
  let total = 0;
  let budgetHit = false;
  let done = 0;
  const queue = [...refs];

  const worker = async () => {
    while (queue.length && alive() && !budgetHit) {
      const ref = queue.shift();
      try {
        const base64 = await context.data.media.read(ref);
        if (!alive()) return;
        total += base64.length;
        if (total > IMAGE_BUDGET_BYTES) { budgetHit = true; missing += 1; }
        else uris.set(ref, `data:${mimeForExt(ref)};base64,${base64}`);
      } catch {
        missing += 1;
      }
      done += 1;
      onProgress(done, refs.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, refs.length) }, worker));
  // whatever the workers left when the budget tripped
  missing += queue.length;
  return { uris, missing, budgetHit };
}

// ---------------------------------------------------------------- builder UI

function typeLabel(type) {
  const raw = String(type ?? "note");
  const bare = (raw.includes(".") ? raw.slice(raw.lastIndexOf(".") + 1) : raw).replaceAll("_", " ");
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

/** camelCase/kebab-case schema field name → a readable label, e.g. "dueDate"
 *  → "Due date". Mirrors `labelOf` in `PropertiesEditor.tsx` — schema fields
 *  carry no label of their own, so both places derive the same one. */
function propLabelOf(name) {
  const withoutTrailingId = String(name ?? "").replace(/Id$/, "");
  const spaced = withoutTrailingId.replaceAll("-", " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Every note's custom properties, two flavours (see `properties-ui.tsx` /
 *  `PropertiesEditor.tsx`): per-type schema fields (`types.schema.fields`,
 *  no built-in label) and per-note ad-hoc `_customFields` (their own
 *  label). Returns `{ catalog, valuesById }`: `catalog` is the deduplicated
 *  `{key,label}` list across every note in the pool, for the picker;
 *  `valuesById` maps note id → `{key: value}` for every key it actually has
 *  set (empty/undefined values are dropped, so "does this note have it" is
 *  just a `has()` away). */
export function collectProperties(pool, typesByName) {
  const catalog = new Map(); // key -> label
  const valuesById = new Map();
  for (const o of pool) {
    let raw;
    try { raw = JSON.parse(o.props || "{}"); } catch { raw = {}; }
    const values = {};
    const schemaFields = parseTypeSchemaFields(typesByName.get(o.type));
    for (const key of Object.keys(schemaFields)) {
      if (!catalog.has(key)) catalog.set(key, propLabelOf(key));
      const v = raw[key];
      if (v !== undefined && v !== null && String(v).trim() !== "") values[key] = v;
    }
    const customFields = Array.isArray(raw._customFields) ? raw._customFields : [];
    for (const field of customFields) {
      if (!field || typeof field.key !== "string" || typeof field.label !== "string") continue;
      if (!catalog.has(field.key)) catalog.set(field.key, field.label);
      const v = raw[field.key];
      if (v !== undefined && v !== null && String(v).trim() !== "") values[field.key] = v;
    }
    if (Object.keys(values).length) valuesById.set(o.id, values);
  }
  return { catalog: [...catalog].map(([key, label]) => ({ key, label })), valuesById };
}

function parseTypeSchemaFields(type) {
  if (!type) return {};
  try {
    const schema = JSON.parse(type.schema);
    return schema && typeof schema.fields === "object" && schema.fields ? schema.fields : {};
  } catch { return {}; }
}

function formatDate(date) {
  // Always English — the document is for a client or a manager, and the rest
  // of the report chrome (headings, "Contents") is English too.
  try {
    return date.toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function mountSurface(context, { container }) {
  const root = el("div", { className: "reportit" });
  root.append(el("style", { textContent: styles }));
  const shell = el("div", { className: "reportit-shell" });
  root.append(shell);
  container.append(root);

  let disposed = false;
  // Themed Select controls mounted via `context.ui.mountSelect` — each is its
  // own Disposable, torn down alongside the rest of the surface.
  const mountedControls = [];
  shell.append(el("p", { className: "rp-note", textContent: "Reading the workspace…" }));

  // reparent-print teardown state, set up once
  let printHost = null;
  let savedDocTitle = null;
  const restorePrint = () => {
    if (printHost) {
      if (printHost.firstChild && preview) preview.append(printHost.firstChild);
      printHost.remove();
      printHost = null;
    }
    if (savedDocTitle !== null) { document.title = savedDocTitle; savedDocTitle = null; }
  };
  const onAfterPrint = () => restorePrint();
  window.addEventListener("afterprint", onAfterPrint);

  let preview; // filled after generate

  void (async () => {
    let objects;
    let types;
    try {
      objects = await context.data.objects.query({ limit: 5000 });
      types = await context.data.types.list();
    } catch (cause) {
      if (!disposed) shell.replaceChildren(el("p", { className: "rp-note", textContent: String(cause?.message ?? cause) }));
      return;
    }
    if (disposed) return;
    const typesByName = new Map((types ?? []).map((t) => [t.name, t]));

    const readTags = (raw) => {
      try {
        const value = JSON.parse(raw || "{}").tags;
        return Array.isArray(value) ? value.filter((t) => typeof t === "string" && t.trim()) : [];
      } catch { return []; }
    };
    const pool = (objects ?? []).map((o) => ({
      id: o.id,
      title: String(o.title ?? "").trim() || "Untitled",
      type: String(o.type ?? "note"),
      content: String(o.content ?? ""),
      parentId: o.parent_id ?? null,
      tags: readTags(o.props),
      props: o.props,
    }));
    const byId = new Map(pool.map((o) => [o.id, o]));
    const { catalog: propertyCatalog, valuesById: propertyValuesById } = collectProperties(pool, typesByName);
    const parentTitles = new Map();
    for (const o of pool) {
      if (o.parentId && byId.has(o.parentId) && !parentTitles.has(o.parentId)) {
        parentTitles.set(o.parentId, byId.get(o.parentId).title);
      }
    }

    shell.replaceChildren();
    if (pool.length === 5000) {
      shell.append(el("p", { className: "rp-note", textContent: "Showing the first 5000 objects — narrow with a filter to reach the rest." }));
    }
    if (pool.length === 0) {
      shell.append(el("p", { className: "rp-note", textContent: "Nothing to put in a report yet." }));
      return;
    }

    // --- state (restored from this session's last builder, if any; ids that
    //     no longer exist in the workspace are dropped)
    const mem = builderMemory ?? {};
    let footerLogoUri = typeof mem.footerLogoUri === "string" && mem.footerLogoUri.startsWith("data:image/") ? mem.footerLogoUri : "";
    const coverLogos = [0, 1].map((i) => typeof mem.coverLogos?.[i] === "string" ? mem.coverLogos[i] : "");
    const selectedIds = Array.isArray(mem.selectedIds) ? mem.selectedIds.filter((id) => pool.some((o) => o.id === id)) : []; // ordered
    const selectedPropKeys = new Set(Array.isArray(mem.propKeys) ? mem.propKeys.filter((key) => propertyCatalog.some((p) => p.key === key)) : []);
    const filters = {
      types: new Set(Array.isArray(mem.types) ? mem.types : []),
      container: typeof mem.container === "string" ? mem.container : "",
      search: typeof mem.search === "string" ? mem.search : "",
      tag: typeof mem.tag === "string" ? mem.tag : "",
    };
    const saveMemory = () => {
      builderMemory = {
        title: titleInput.value,
        description: descInput.value,
        footerNote: footerNoteInput.value,
        footerLogoUri,
        coverLogos: [...coverLogos],
        footerAlign: footerAlignValue,
        pageNumbers: pageNumbers.checked,
        types: [...filters.types],
        container: filters.container,
        search: filters.search,
        tag: filters.tag,
        selectedIds: [...selectedIds],
        propKeys: [...selectedPropKeys],
        showType: showType.checked,
      };
    };

    const builder = el("div", { className: "reportit-builder" });
    const poolCol = el("div", { className: "reportit-col" });
    const pickCol = el("div", { className: "reportit-col" });
    builder.append(poolCol, pickCol);
    shell.append(builder);

    // --- pool column
    const typeSet = [...new Set(pool.map((o) => o.type))].sort();
    const filterBar = el("div", { className: "reportit-filters" });
    const typeChips = el("div", { className: "reportit-typechips" });
    for (const type of typeSet) {
      const chip = el("button", { type: "button", className: "reportit-chip", textContent: typeLabel(type) });
      chip.dataset.on = filters.types.has(type) ? "yes" : "no";
      chip.addEventListener("click", () => {
        if (filters.types.has(type)) { filters.types.delete(type); chip.dataset.on = "no"; }
        else { filters.types.add(type); chip.dataset.on = "yes"; }
        renderPool();
      });
      typeChips.append(chip);
    }
    // Container / tag filters use the host's themed Select (`context.ui.mountSelect`,
    // API 1.11) rather than a native <select> — a native control looks like
    // every other browser page, not like the app's own `nb-select` dropdowns
    // (see the Footer alignment control below for the same reasoning).
    const containerOptions = [
      { value: "", label: "Any container" },
      ...[...parentTitles].sort((a, b) => a[1].localeCompare(b[1])).map(([pid, title]) => ({ value: pid, label: title })),
    ];
    if (!containerOptions.some((o) => o.value === filters.container)) filters.container = ""; // drop a remembered id that no longer resolves
    const containerMount = el("div", { className: "reportit-select-mount" });
    mountedControls.push(context.ui.mountSelect(containerMount, {
      value: filters.container,
      options: containerOptions,
      ariaLabel: "Container",
      onChange: (value) => { filters.container = value; renderPool(); },
    }));
    // Tag filter: union of every object's props.tags. Hidden entirely when the
    // workspace has no tags, so it does not add a dead control to the bar.
    const allTags = [...new Set(pool.flatMap((o) => o.tags))].sort((a, b) => a.localeCompare(b));
    filters.tag = allTags.includes(filters.tag) ? filters.tag : "";
    const tagMount = el("div", { className: "reportit-select-mount", hidden: allTags.length === 0 });
    mountedControls.push(context.ui.mountSelect(tagMount, {
      value: filters.tag,
      options: [{ value: "", label: "Any tag" }, ...allTags.map((tag) => ({ value: tag, label: tag }))],
      ariaLabel: "Tag",
      onChange: (value) => { filters.tag = value; renderPool(); },
    }));
    const searchInput = el("input", { className: "reportit-search", type: "search", placeholder: "Search titles…" });
    searchInput.value = filters.search;
    searchInput.addEventListener("input", () => { filters.search = searchInput.value.trim().toLowerCase(); renderPool(); });
    const typeDetails = el("details", { className: "reportit-type-filter" }, [el("summary", { textContent: "Types" }), typeChips]);
    filterBar.append(searchInput, containerMount, tagMount, typeDetails);
    const poolCount = el("span", { className: "reportit-count" });
    poolCol.append(
      el("h3", { className: "reportit-col-head reportit-pool-head" }, [textNode("Choose content"), poolCount]),
      filterBar,
    );

    const poolList = el("div", { className: "reportit-list" });
    const selectAll = el("input", { type: "checkbox" });
    const selectAllText = el("span", { textContent: "Select all results" });
    poolCol.append(el("label", { className: "reportit-select-all" }, [selectAll, selectAllText]), poolList);
    const clearBtn = el("button", { type: "button", className: "reportit-bulk", textContent: "Clear selection" });
    poolCol.append(el("div", { className: "reportit-bulkrow" }, [clearBtn]));

    const matchesFilters = (o) => {
      if (filters.types.size && !filters.types.has(o.type)) return false;
      if (filters.container && o.parentId !== filters.container) return false;
      if (filters.tag && !o.tags.includes(filters.tag)) return false;
      if (filters.search && !o.title.toLowerCase().includes(filters.search)) return false;
      return true;
    };

    selectAll.addEventListener("change", () => {
      const matching = new Set(pool.filter(matchesFilters).map((o) => o.id));
      if (selectAll.checked) {
        for (const id of matching) if (!selectedIds.includes(id)) selectedIds.push(id);
      } else {
        // Deselect only this filtered list; selections outside it stay intact.
        for (let i = selectedIds.length - 1; i >= 0; i -= 1) if (matching.has(selectedIds[i])) selectedIds.splice(i, 1);
      }
      renderPicks();
      renderPool();
    });
    clearBtn.addEventListener("click", () => {
      selectedIds.length = 0;
      renderPicks();
      renderPool();
    });

    function renderPool() {
      poolList.replaceChildren();
      const rows = pool.filter(matchesFilters);
      poolCount.textContent = rows.length === pool.length ? `${pool.length}` : `${rows.length} / ${pool.length}`;
      const unpicked = rows.filter((o) => !selectedIds.includes(o.id)).length;
      selectAll.disabled = rows.length === 0;
      selectAll.checked = rows.length > 0 && unpicked === 0;
      selectAll.indeterminate = unpicked > 0 && unpicked < rows.length;
      selectAllText.textContent = `Select all results (${rows.length})`;
      typeDetails.querySelector("summary").textContent = filters.types.size ? `Types (${filters.types.size})` : "Types · All";
      clearBtn.disabled = selectedIds.length === 0;
      for (const o of rows) {
        const row = el("label", { className: "reportit-poolrow" });
        const box = el("input", { type: "checkbox" });
        box.checked = selectedIds.includes(o.id);
        box.addEventListener("change", () => {
          if (box.checked) { if (!selectedIds.includes(o.id)) selectedIds.push(o.id); }
          else { const at = selectedIds.indexOf(o.id); if (at >= 0) selectedIds.splice(at, 1); }
          renderPicks();
          renderPool();
        });
        row.append(box, el("span", { className: "reportit-poolrow-title", textContent: o.title }), el("span", { className: "reportit-poolrow-type", textContent: typeLabel(o.type) }));
        poolList.append(row);
      }
      if (!rows.length) poolList.append(el("p", { className: "rp-note", textContent: "No objects match the filters." }));
      saveMemory();
    }

    // --- pick column
    const pickCount = el("span", { className: "reportit-count" });
    pickCol.append(el("h3", { className: "reportit-col-head" }, [textNode("Report details"), pickCount]));
    const titleInput = el("input", { className: "reportit-title-input", type: "text", placeholder: "Report title (required)", value: typeof mem.title === "string" ? mem.title : "" });
    const descInput = el("textarea", { className: "reportit-desc-input", placeholder: "Short description (optional)", rows: 2 });
    descInput.value = typeof mem.description === "string" ? mem.description : "";
    descInput.addEventListener("input", saveMemory);
    pickCol.append(titleInput, descInput);

    // Optional page footer: a note (e.g. "Confidential") and/or a small logo.
    // The logo is read from a local file into a data: URI here — no upload, no
    // network, nothing persisted past this app session.
    const footerFields = el("div", { className: "reportit-footer-fields" });
    footerFields.append(el("h3", { className: "reportit-col-head", textContent: "Page footer (optional)" }));
    const footerNoteInput = el("input", { className: "reportit-title-input", type: "text", placeholder: "Footer note, e.g. Confidential", value: typeof mem.footerNote === "string" ? mem.footerNote : "" });
    footerNoteInput.addEventListener("input", saveMemory);
    footerNoteInput.maxLength = 240;
    let footerAlignValue = mem.footerAlign === "left" ? "left" : "right";
    const footerAlignMount = el("div", { className: "reportit-select-mount" });
    mountedControls.push(context.ui.mountSelect(footerAlignMount, {
      value: footerAlignValue,
      options: [{ value: "left", label: "Footer on the left" }, { value: "right", label: "Footer on the right" }],
      ariaLabel: "Footer alignment",
      onChange: (value) => { footerAlignValue = value; saveMemory(); },
    }));
    const pageNumbers = el("input", { type: "checkbox", checked: mem.pageNumbers === true });
    pageNumbers.addEventListener("change", saveMemory);
    // Native file inputs render their button/status text in the OS UI language,
    // not the app's — hide it and drive the visible text ourselves so it stays
    // in the app's chosen language regardless of Windows locale.
    const logoInput = el("input", { className: "reportit-logo-input-native", type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", hidden: true });
    const logoChoose = el("button", { type: "button", className: "reportit-bulk", textContent: "Choose footer logo" });
    const logoStatus = el("span", { className: "reportit-logo-status", textContent: "No logo chosen" });
    const logoPreview = el("img", { className: "reportit-logo-preview", alt: "", hidden: true });
    const logoClear = el("button", { type: "button", className: "reportit-bulk", textContent: "Remove logo", hidden: true });
    logoChoose.addEventListener("click", () => logoInput.click());
    const syncLogo = () => {
      logoPreview.hidden = !footerLogoUri;
      if (footerLogoUri) logoPreview.src = footerLogoUri;
      logoClear.hidden = !footerLogoUri;
      logoStatus.textContent = footerLogoUri ? "Logo selected" : "No logo chosen";
    };
    logoInput.addEventListener("change", () => {
      const file = logoInput.files && logoInput.files[0];
      logoInput.value = "";
      if (!file) return;
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { context.ui.notice("Choose a PNG, JPEG, WebP or GIF image."); return; }
      if (file.size > 512 * 1024) { context.ui.notice("Footer logo must be under 512 KB."); return; }
      const reader = new FileReader();
      reader.onload = () => { if (disposed) return; footerLogoUri = String(reader.result || ""); saveMemory(); syncLogo(); };
      reader.onerror = () => context.ui.notice("Could not read that image.");
      reader.readAsDataURL(file);
    });
    logoClear.addEventListener("click", () => { footerLogoUri = ""; saveMemory(); syncLogo(); });
    footerFields.append(footerNoteInput, el("div", { className: "reportit-logo-row" }, [logoInput, logoChoose, logoStatus, logoPreview, logoClear]),
      el("div", { className: "reportit-logo-row" }, [footerAlignMount, el("label", { className: "reportit-option" }, [pageNumbers, textNode("Number pages (including cover)")]) ]));
    const coverFields = el("details", { className: "reportit-document-options" }, [el("summary", { textContent: "Cover logos (optional)" })]);
    for (const [index, label] of ["Company logo", "Client logo"].entries()) {
      const input = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", hidden: true });
      const choose = el("button", { type: "button", className: "reportit-bulk", textContent: `Choose ${label.toLowerCase()}` });
      const thumbnail = el("img", { className: "reportit-logo-preview", alt: label });
      const remove = el("button", { type: "button", className: "reportit-bulk", textContent: "Remove", ariaLabel: `Remove ${label.toLowerCase()}` });
      const sync = () => { thumbnail.hidden = remove.hidden = !coverLogos[index]; if (coverLogos[index]) thumbnail.src = coverLogos[index]; };
      choose.addEventListener("click", () => input.click());
      remove.addEventListener("click", () => { coverLogos[index] = ""; sync(); saveMemory(); });
      input.addEventListener("change", () => {
        const file = input.files?.[0]; input.value = "";
        if (!file) return;
        if (file.size > 512 * 1024 || !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { context.ui.notice("Choose a PNG, JPEG, WebP or GIF logo under 512 KB."); return; }
        const reader = new FileReader();
        reader.onload = () => { if (disposed) return; coverLogos[index] = String(reader.result || ""); sync(); saveMemory(); };
        reader.onerror = () => context.ui.notice("Could not read that image.");
        reader.readAsDataURL(file);
      });
      coverFields.append(el("div", { className: "reportit-logo-row" }, [input, choose, thumbnail, remove]));
      sync();
    }
    syncLogo();
    // Properties to print under each section's title — a workspace-wide
    // picklist of the custom property keys found on any note in the pool
    // (schema fields + per-note `_customFields`, see `collectProperties`).
    // A note missing a checked key just skips that line at render time, so
    // one picklist covers notes whose fields differ (see design discussion:
    // per-note picking was ruled out as a v2, not now).
    // Properties to print under each section's title. Chips are scoped to
    // the *currently selected* sections, not the whole workspace pool — a
    // flat union across every type in the workspace (Task/Project/Note, each
    // with its own schema) grows into a wall of unrelated fields (Budget,
    // Milestone, Cycle, ...) the moment a report mixes types; showing only
    // keys at least one selected note actually has keeps it to what's
    // relevant for THIS report. A checked key stays checked even if it
    // scrolls out of the visible set (e.g. every note carrying it gets
    // removed) — it reappears, still checked, if a matching note comes back.
    const showType = el("input", { type: "checkbox", checked: mem.showType !== false });
    showType.addEventListener("change", saveMemory);
    const propertyChips = el("div", { className: "reportit-typechips" });
    function renderPropertyChips() {
      propertyChips.replaceChildren();
      const visible = propertyCatalog.filter((p) => selectedIds.some((id) => propertyValuesById.get(id)?.[p.key] !== undefined));
      for (const { key, label } of visible) {
        const chip = el("button", { type: "button", className: "reportit-chip", textContent: label });
        chip.dataset.on = selectedPropKeys.has(key) ? "yes" : "no";
        chip.addEventListener("click", () => {
          if (selectedPropKeys.has(key)) { selectedPropKeys.delete(key); chip.dataset.on = "no"; }
          else { selectedPropKeys.add(key); chip.dataset.on = "yes"; }
          saveMemory();
        });
        propertyChips.append(chip);
      }
      if (!visible.length) propertyChips.append(el("p", { className: "rp-note", textContent: "None of the selected sections have a custom property." }));
    }
    const propertiesDetails = el("details", { className: "reportit-type-filter", hidden: propertyCatalog.length === 0 }, [
      el("summary", { textContent: "Properties to include" }),
      el("label", { className: "reportit-select-all" }, [showType, textNode("Show note type (Task, Project, …)")]),
      propertyChips,
    ]);
    const pickList = el("div", { className: "reportit-list reportit-picklist" });
    pickCol.append(el("h3", { className: "reportit-col-head reportit-selection-head", textContent: "Sections · drag to reorder" }), pickList, propertiesDetails, coverFields, footerFields);
    const generateBtn = el("button", { type: "button", className: "reportit-generate", textContent: "Generate report" });
    pickCol.append(generateBtn);
    const genNote = el("p", { className: "rp-note" });
    pickCol.append(genNote);

    titleInput.addEventListener("input", () => { updateGenerateEnabled(); saveMemory(); });
    function updateGenerateEnabled() {
      generateBtn.disabled = selectedIds.length === 0 || titleInput.value.trim() === "";
    }
    const movePick = (from, to) => {
      if (to < 0 || to >= selectedIds.length) return;
      const [moved] = selectedIds.splice(from, 1);
      selectedIds.splice(to, 0, moved);
      renderPicks();
    };

    // pointer-drag reorder (HTML5 DnD is dead in the Tauri webview). The grip
    // is the only control shown at rest — Move up/down stay in the DOM for
    // keyboard and screen-reader users (self-check asserts they exist; a
    // drag gesture alone is not operable without a pointer) but are visually
    // hidden until the row is hovered or a control inside it has focus, via
    // CSS (`:hover`/`:focus-within`), so the default row reads as just the
    // grip instead of grip-plus-two-arrow-buttons.
    //
    // Reorder is "shift to make room, commit on drop" (the Trello/dnd-kit
    // pattern), not "re-render the whole list on every pixel". An earlier
    // version spliced `selectedIds` and called a full `renderPicks()` on
    // every row the pointer crossed — tearing down and recreating every row
    // (fresh elements, fresh listeners) several times a second, with a FLIP
    // animation racing to catch up on each one. That read as ghosting and
    // jitter, because it was: overlapping, restarted transitions on
    // continuously-replaced DOM nodes. Now: `selectedIds` is untouched, and
    // the DOM is untouched, until the pointer is released. While dragging,
    // the only thing that changes is `transform` on existing rows: the
    // dragged one tracks the pointer directly, the rows it has crossed shift
    // by exactly one slot to preview the gap. One cheap style write per
    // move, no rebuild, no listener churn, nothing to race.
    const reduceMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

    function renderPicks({ animate = true } = {}) {
      // FLIP: capture every row's position before the rebuild below replaces
      // them, keyed by object id (index shifts on every reorder, id does
      // not). Skipped right after a drag commits — the live shift preview
      // already showed each row exactly where the rebuild is about to put
      // it, so animating "from" the pre-drag position would jump backwards
      // first.
      const oldRects = animate ? new Map() : null;
      if (oldRects) {
        for (const row of pickList.children) {
          if (row.dataset && row.dataset.id) oldRects.set(row.dataset.id, row.getBoundingClientRect());
        }
      }
      pickList.replaceChildren();
      selectedIds.forEach((id, index) => {
        const o = byId.get(id);
        if (!o) return;
        const row = el("div", { className: "reportit-pickrow" });
        row.dataset.index = String(index);
        row.dataset.id = id;
        const upBtn = el("button", { type: "button", className: "reportit-move", textContent: "▲", title: "Move up" });
        upBtn.disabled = index === 0;
        upBtn.addEventListener("click", () => movePick(index, index - 1));
        const downBtn = el("button", { type: "button", className: "reportit-move", textContent: "▼", title: "Move down" });
        downBtn.disabled = index === selectedIds.length - 1;
        downBtn.addEventListener("click", () => movePick(index, index + 1));
        const grip = el("button", { type: "button", className: "reportit-grip", textContent: "⠿", title: "Drag to reorder" });
        grip.addEventListener("pointerdown", (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          // A snapshot: the order at the moment the drag starts. It never
          // changes during the drag (only the preview does) — `targetIndex`
          // below is always relative to THIS, not to whatever the live DOM
          // looks like mid-gesture.
          const startOrder = [...selectedIds];
          const startIndex = startOrder.indexOf(id);
          const rows = [...pickList.children];
          // Centre-to-centre row spacing, including the list's flex `gap` —
          // measured, not assumed, so a density/theme change can't desync it.
          const slotHeight = rows.length > 1
            ? Math.abs(rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top)
            : row.getBoundingClientRect().height;
          const startClientY = event.clientY;
          let targetIndex = startIndex;
          row.dataset.dragging = "yes";

          // Auto-scroll the list when the pointer nears its top/bottom edge —
          // without this, dragging toward a row above/below the visible
          // window just runs the dragged row into the container's
          // `overflow-y: auto` clip and it disappears mid-drag, with no way
          // to reach anything outside the current scroll position. Scrolling
          // the container changes the dragged row's *unscrolled* screen
          // position, so `scrollAdjust` folds that shift back into `apply`'s
          // deltaY — otherwise the row would lag behind or jump once
          // autoscroll starts moving content under it.
          const EDGE_ZONE = 28;
          const MAX_SCROLL_SPEED = 16;
          let lastClientY = startClientY;
          let scrollAdjust = 0;
          let autoScrollFrame = null;
          const autoScrollTick = () => {
            const listRect = pickList.getBoundingClientRect();
            let speed = 0;
            if (lastClientY < listRect.top + EDGE_ZONE) {
              speed = -MAX_SCROLL_SPEED * Math.min(1, (listRect.top + EDGE_ZONE - lastClientY) / EDGE_ZONE);
            } else if (lastClientY > listRect.bottom - EDGE_ZONE) {
              speed = MAX_SCROLL_SPEED * Math.min(1, (lastClientY - (listRect.bottom - EDGE_ZONE)) / EDGE_ZONE);
            }
            if (speed) {
              const before = pickList.scrollTop;
              pickList.scrollTop = Math.max(0, Math.min(pickList.scrollHeight - pickList.clientHeight, before + speed));
              const applied = pickList.scrollTop - before;
              if (applied) { scrollAdjust += applied; apply(lastClientY); }
            }
            autoScrollFrame = requestAnimationFrame(autoScrollTick);
          };
          autoScrollFrame = requestAnimationFrame(autoScrollTick);

          const apply = (clientY) => {
            lastClientY = clientY;
            const deltaY = clientY - startClientY + scrollAdjust;
            row.style.transition = "none";
            row.style.transform = `translateY(${deltaY}px)`;
            const slots = Math.round(deltaY / slotHeight);
            targetIndex = Math.max(0, Math.min(startOrder.length - 1, startIndex + slots));
            for (const other of rows) {
              if (other === row) continue;
              const otherIndex = startOrder.indexOf(other.dataset.id);
              let shift = 0;
              if (targetIndex > startIndex && otherIndex > startIndex && otherIndex <= targetIndex) shift = -1;
              else if (targetIndex < startIndex && otherIndex < startIndex && otherIndex >= targetIndex) shift = 1;
              other.style.transition = reduceMotion ? "none" : "transform 140ms cubic-bezier(.2, .8, .2, 1)";
              other.style.transform = shift ? `translateY(${shift * slotHeight}px)` : "";
            }
          };
          apply(startClientY);
          const move = (moveEvent) => apply(moveEvent.clientY);
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            if (autoScrollFrame !== null) cancelAnimationFrame(autoScrollFrame);
            if (targetIndex !== startIndex) {
              const [moved] = selectedIds.splice(startIndex, 1);
              selectedIds.splice(targetIndex, 0, moved);
            }
            // One clean rebuild commits the move, resets every inline
            // transform/transition, and reattaches fresh listeners. Skips
            // the FLIP playback: the shift preview above already left every
            // row exactly where this puts it.
            renderPicks({ animate: false });
            saveMemory();
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        });
        const remove = el("button", { type: "button", className: "reportit-remove", textContent: "×", title: "Remove" });
        remove.addEventListener("click", () => {
          const at = selectedIds.indexOf(id);
          if (at >= 0) selectedIds.splice(at, 1);
          renderPicks();
          renderPool();
        });
        row.append(upBtn, downBtn, grip, el("span", { className: "reportit-pickrow-title", textContent: o.title }), el("span", { className: "reportit-pickrow-type", textContent: typeLabel(o.type) }), remove);
        pickList.append(row);
      });
      if (!selectedIds.length) pickList.append(el("p", { className: "rp-note", textContent: "Choose objects on the left, or select all filtered results." }));
      pickCount.textContent = `${selectedIds.length} sections`;
      renderPropertyChips();
      updateGenerateEnabled();
      saveMemory();

      // FLIP playback for the paths that still do a plain rebuild (the
      // Move up/down buttons, ticking/unticking a pool row, Remove): every
      // row animates from where it used to be to where the rebuild put it.
      if (oldRects && !reduceMotion) {
        for (const row of pickList.children) {
          const id = row.dataset.id;
          if (!id) continue;
          const oldRect = oldRects.get(id);
          if (!oldRect) continue;
          const newRect = row.getBoundingClientRect();
          const deltaY = oldRect.top - newRect.top;
          if (Math.abs(deltaY) < 0.5) continue;
          row.style.transition = "none";
          row.style.transform = `translateY(${deltaY}px)`;
          requestAnimationFrame(() => {
            row.style.transition = "transform 180ms cubic-bezier(.2, .8, .2, 1)";
            row.style.transform = "";
          });
        }
      }
    }

    // --- generate
    preview = el("div", { className: "reportit-preview" });
    const printBtn = el("button", { type: "button", className: "reportit-print", textContent: "Print / Save as PDF" });
    const editBtn = el("button", { type: "button", className: "reportit-edit", textContent: "Edit selection" });
    const previewWrap = el("div", { className: "reportit-preview-wrap", hidden: true }, [
      el("div", { className: "reportit-preview-bar" }, [printBtn, editBtn]),
      el("p", { className: "rp-note reportit-preview-note" }),
      preview,
    ]);
    shell.append(previewWrap);

    const exitPreview = () => { previewWrap.hidden = true; builder.hidden = false; };
    editBtn.addEventListener("click", exitPreview);
    // Core's global Back button unwinds *section* history, which never
    // changes while inside this view — without this guard, Back on the
    // generated-report screen jumps straight past the builder to whatever
    // was open before ReportIt. Only consume Back while the preview is
    // actually showing; otherwise fall through to Core's own history.
    window.dispatchEvent(new CustomEvent("notible:plugin-back-guard", {
      detail: { handler: () => { if (previewWrap.hidden) return false; exitPreview(); return true; } },
    }));

    printBtn.addEventListener("click", () => {
      if (!preview.firstChild || printHost) return;
      if (typeof window.print !== "function") { context.ui.notice("Printing is not available in this host."); return; }
      // Chromium's Save-as-PDF names the file after `document.title` — point it
      // at the report title for this print, restore afterwards.
      savedDocTitle = document.title;
      document.title = titleInput.value.trim() || "Report";
      // Reparent the document out of every overflow/clip ancestor so the print
      // engine can paginate it, print, and put it back on afterprint.
      printHost = el("div", { id: "rp-print-host" });
      printHost.append(preview.firstChild);
      document.body.append(printHost);
      requestAnimationFrame(() => { window.print(); });
    });

    generateBtn.addEventListener("click", async () => {
      if (!selectedIds.length || !titleInput.value.trim() || builder.inert) return;
      generateBtn.disabled = true;
      builder.inert = true;
      genNote.textContent = "Building the report…";
      try {
      const sections = selectedIds.map((id) => {
        const o = byId.get(id);
        const values = propertyValuesById.get(id) ?? {};
        const properties = propertyCatalog
          .filter((p) => selectedPropKeys.has(p.key) && values[p.key] !== undefined)
          .map((p) => ({ label: p.label, value: String(values[p.key]) }));
        return { title: o.title, type: showType.checked ? typeLabel(o.type) : "", blocks: normalizeHeadings(renderMarkdown(tiptapToMarkdown(o.content))), properties };
      });
      const refs = [...new Set(sections.flatMap((s) => mediaRefsIn(s.blocks)))];
      const total = refs.length;
      let result = { uris: new Map(), missing: 0, budgetHit: false };
      if (total) {
        genNote.textContent = `Loading images 0/${total}…`;
        result = await loadImages(
          context,
          refs,
          (done, count) => { if (!disposed) genNote.textContent = `Loading images ${done}/${count}…`; },
          () => !disposed,
        );
      }
      if (disposed) return;
      await drawDiagrams(context, sections, result.uris);
      if (disposed) return;

      const model = reportModel({
        title: titleInput.value,
        description: descInput.value,
        dateText: formatDate(new Date()),
        sections,
        footer: { note: footerNoteInput.value, logoUri: footerLogoUri, align: footerAlignValue, pageNumbers: pageNumbers.checked },
        coverLogos,
      });
      const documentPages = await renderReport(model, result.uris, root);
      if (disposed) return;
      preview.replaceChildren(documentPages);
      preview.scrollTop = 0;

      const noteParts = [`${documentPages.children.length} A4 pages · Print at 100% scale, A4, with browser headers and footers off.`];
      if (result.missing) noteParts.push(`${result.missing} of ${total} images could not be included`);
      if (result.budgetHit) noteParts.push("the report is over the image budget");
      if (result.missing && !result.budgetHit) noteParts.push("check “Let plugins read pasted images” in Settings → Files & links");
      previewWrap.querySelector(".reportit-preview-note").textContent = noteParts.join(" · ");
      previewWrap.querySelector(".reportit-preview-note").hidden = noteParts.length === 0;

      printBtn.hidden = typeof window.print !== "function";
      if (!printBtn.hidden) { /* keep */ } else {
        previewWrap.querySelector(".reportit-preview-note").textContent = "Printing is not available in this host — this is the on-screen preview only.";
        previewWrap.querySelector(".reportit-preview-note").hidden = false;
      }

      builder.hidden = true;
      previewWrap.hidden = false;
      genNote.textContent = "";
      } catch (cause) {
        if (!disposed) genNote.textContent = `Could not prepare the report: ${String(cause?.message ?? cause)}`;
      } finally {
        if (!disposed) { builder.inert = false; updateGenerateEnabled(); }
      }
    });

    renderPool();
    renderPicks();
  })();

  return {
    dispose: () => {
      disposed = true;
      window.removeEventListener("afterprint", onAfterPrint);
      restorePrint();
      window.dispatchEvent(new CustomEvent("notible:plugin-back-guard", { detail: { handler: null } }));
      for (const control of mountedControls) control.dispose();
      root.remove();
    },
  };
}

// ------------------------------------------------------------------------- CSS
//
// The builder chrome paints from --notible-* tokens like every other plugin
// surface. The DOCUMENT (`.rp-doc`) is a fixed light page — black on white,
// serif body, sans headings — so its colour literals are intentional:
// plugin-css-token-check exempts a `.rp-doc` scope for this plugin.
const styles = `
.reportit { color: var(--notible-text); font-size: 13px; }
.reportit [hidden] { display: none !important; }
.reportit-measure { position: fixed; left: -10000px; top: 0; visibility: hidden; width: 210mm; pointer-events: none; }
.reportit-shell { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.rp-note { margin: 0; color: var(--notible-muted); font-size: 12px; line-height: 1.5; }

.reportit-builder { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; align-items: start; min-height: 0; }
@media (max-width: 900px) { .reportit-builder { grid-template-columns: 1fr; } }
.reportit-col { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.reportit-col-head { margin: 0 0 4px; font-size: 14px; font-weight: 600; color: var(--notible-text); }
.reportit-selection-head { margin-top: 12px; }
.reportit-select-all, .reportit-option { display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer; }
.reportit-select-all { padding: 10px 6px 6px; border-bottom: 1px solid var(--notible-border); }
.reportit-type-filter, .reportit-document-options { font-size: 12px; }
.reportit-type-filter summary, .reportit-document-options summary { cursor: pointer; padding: 8px 0; color: var(--notible-muted); }
.reportit-type-filter { flex-basis: 100%; }
.reportit-document-options { border-top: 1px solid var(--notible-border); margin-top: 8px; }
.reportit-document-options .reportit-logo-row { margin: 8px 0; }
.reportit input[type="checkbox"] { accent-color: var(--notible-accent); width: 15px; height: 15px; flex: none; }
.reportit button:focus-visible, .reportit input:focus-visible, .reportit select:focus-visible, .reportit summary:focus-visible { outline: 2px solid var(--notible-accent); outline-offset: 2px; }
.reportit-count { margin-left: 6px; color: var(--notible-faint); font-weight: 500; }
.reportit-count:empty { display: none; }
.reportit-bulkrow { display: flex; gap: 8px; }
.reportit-bulk { border: 1px solid var(--notible-border); border-radius: 7px; background: transparent; color: var(--notible-muted); font: inherit; font-size: 12px; padding: 4px 10px; cursor: pointer; }
.reportit-bulk:hover:not(:disabled) { background: var(--notible-hover); }
.reportit-bulk:disabled { opacity: .45; cursor: default; }
/* Hidden at rest so the row reads as just the drag grip; revealed on hover
   or once a control inside the row has focus, so Tab still reaches (and
   shows) these for keyboard/screen-reader users who cannot drag. The
   :disabled rule comes last so it still wins over the reveal — a disabled
   arrow at either end of the list stays visibly dim rather than snapping to
   full strength just because the row is hovered. */
.reportit-move { flex: none; border: 0; background: none; color: var(--notible-muted); cursor: pointer; font-size: 10px; line-height: 1; padding: 2px 3px; opacity: 0; transition: opacity 120ms ease; }
.reportit-pickrow:hover .reportit-move,
.reportit-pickrow:focus-within .reportit-move { opacity: 1; }
.reportit-move:disabled { opacity: .3; cursor: default; }
.reportit-filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.reportit-typechips { display: flex; flex-wrap: wrap; gap: 6px; }
.reportit-chip { border: 1px solid var(--notible-border); border-radius: 7px; background: transparent; color: var(--notible-muted); font: inherit; font-size: 12px; padding: 3px 9px; cursor: pointer; }
.reportit-chip:hover { border-color: var(--notible-accent); color: var(--notible-text); }
.reportit-chip[data-on="yes"] { border-color: var(--notible-accent); background: var(--notible-selected); color: var(--notible-accent); }
.reportit-search, .reportit-title-input, .reportit-desc-input { min-width: 0; border: 1px solid var(--notible-border); border-radius: 7px; background: var(--notible-surface); color: var(--notible-text); font: inherit; font-size: 12px; padding: 6px 9px; }
.reportit-desc-input { resize: vertical; }
.reportit-search { flex: 1 0 100%; box-sizing: border-box; height: 36px; }
/* Container / tag filters and the footer-alignment control are the host's
   themed Select (context.ui.mountSelect), not a native select — this
   wrapper just sizes the mount point, the control paints itself. */
.reportit-select-mount { min-width: 140px; }
.reportit-filters > .reportit-select-mount { flex: 1; }
.reportit-title-input { min-height: 36px; box-sizing: border-box; }
.reportit-list { display: flex; flex-direction: column; gap: 2px; max-height: 46vh; overflow-y: auto; border: 1px solid var(--notible-border-subtle, var(--notible-border)); border-radius: 8px; padding: 4px; }
.reportit-poolrow { display: flex; align-items: center; gap: 8px; padding: 9px 6px; border-radius: 6px; cursor: pointer; }
.reportit-poolrow:hover { background: var(--notible-hover); }
.reportit-poolrow-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reportit-poolrow-type, .reportit-pickrow-type { flex: none; color: var(--notible-faint); font-size: 11px; }
.reportit-pickrow { display: flex; align-items: center; gap: 8px; padding: 9px 6px; border-radius: 6px; background: transparent; }
.reportit-pickrow:hover { background: var(--notible-hover); }
/* The lifted card the pointer is carrying — opaque and raised, not dimmed,
   since it is now following the cursor rather than sitting in place while a
   drop target is marked elsewhere (the old design). */
.reportit-pickrow[data-dragging="yes"] { position: relative; z-index: 5; background: var(--notible-surface); box-shadow: 0 8px 20px rgba(0, 0, 0, .18); cursor: grabbing; }
.reportit-pickrow-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reportit-grip { flex: none; border: 0; background: none; color: var(--notible-muted); cursor: grab; font-size: 13px; padding: 2px 4px; }
.reportit-remove { flex: none; border: 0; background: none; color: var(--notible-faint); cursor: pointer; font-size: 14px; padding: 2px 6px; }
.reportit-remove:hover { color: var(--notible-danger); }
.reportit-generate, .reportit-print { align-self: flex-start; border: 1px solid var(--notible-accent); border-radius: 7px; background: var(--notible-accent); color: var(--notible-on-accent); font: inherit; font-weight: 600; font-size: 12px; padding: 6px 14px; cursor: pointer; }
.reportit-generate:disabled { opacity: .5; cursor: default; }
.reportit-edit { border: 1px solid var(--notible-border); border-radius: 7px; background: transparent; color: var(--notible-muted); font: inherit; font-size: 12px; padding: 6px 12px; cursor: pointer; }
.reportit-footer-fields { display: flex; flex-direction: column; gap: 6px; margin-top: 2px; border-top: 1px solid var(--notible-border-subtle, var(--notible-border)); padding-top: 8px; }
.reportit-logo-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.reportit-logo-status { font-size: 11px; color: var(--notible-muted); }
.reportit-logo-preview { max-height: 26px; max-width: 90px; object-fit: contain; border: 1px solid var(--notible-border-subtle, var(--notible-border)); border-radius: 4px; }
.reportit-preview-wrap { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.reportit-preview-bar { display: flex; gap: 10px; align-items: center; }
/* No card here — the report sheet floats on the workspace background like the
   rest of the plugin chrome. Padding is just breathing room around the sheet. */
.reportit-preview { padding: 12px; background: var(--notible-hover); overflow: auto; max-height: 72vh; }

/* palette-exempt: the report is a fixed light document (black on white,
   always), not a themed surface — its colour literals are intentional and
   plugin-css-token-check skips this region. */
.rp-doc { color: #1a1a1a; font-family: Georgia, "Times New Roman", serif; font-size: 11pt; line-height: 1.55; width: 210mm; margin: 0 auto; padding: 0; text-align: left; }
.rp-doc * { box-sizing: border-box; }
.rp-page { position: relative; width: 210mm; height: 297mm; padding: 18mm 18mm 28mm; margin: 0 0 20px; background: #fff; box-shadow: 0 1px 6px rgba(0, 0, 0, .12); break-after: page; }
.rp-page:last-child { break-after: auto; }
.rp-page-content { display: flow-root; height: 251mm; overflow: visible; overflow-wrap: anywhere; }
.rp-doc .rp-page-content > :first-child { margin-top: 0; }
.rp-doc h1, .rp-doc h2, .rp-doc h3, .rp-doc h4, .rp-doc h5, .rp-doc h6 { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #111; line-height: 1.25; }
.rp-doc .rp-cover { display: flow-root; padding: 18mm 0 0; border-top: 2px solid #222; }
.rp-doc .rp-cover-logos { display: flex; justify-content: space-between; align-items: center; gap: 16mm; margin-bottom: 32mm; }
.rp-doc .rp-cover-logos img { max-width: 70mm; max-height: 25mm; object-fit: contain; }
.rp-doc .rp-cover-eyebrow { font: 9pt system-ui, sans-serif; letter-spacing: .18em; color: #666; margin: 0 0 8mm; }
.rp-doc .rp-title { font-size: 30pt; font-weight: 700; margin: 0 0 8mm; white-space: normal; overflow: visible; text-overflow: clip; height: auto; max-height: none; overflow-wrap: anywhere; }
.rp-date { margin: 0 0 16px; color: #666; font-family: system-ui, sans-serif; font-size: 10pt; }
.rp-desc { margin: 0; max-width: 60ch; color: #333; }
.rp-doc .rp-toc-title { font-size: 22pt; margin: 0 0 10mm; }
.rp-doc .rp-toc-entry { display: flex; align-items: baseline; gap: 4mm; font-size: 11pt; line-height: 1.65; margin: 0 0 4mm; color: inherit; text-decoration: none; }
.rp-doc .rp-toc-number { min-width: 7mm; flex: none; color: #777; font: 9pt system-ui, sans-serif; font-variant-numeric: tabular-nums; }
.rp-section { margin: 0; }
.rp-doc .rp-section-title { font-size: 18pt; font-weight: 650; margin: 0 0 3mm; white-space: normal; overflow: visible; text-overflow: clip; height: auto; max-height: none; overflow-wrap: anywhere; }
.rp-doc .rp-section-head { margin-bottom: 8mm; }
.rp-section-type { margin: 2px 0 10px; font-family: system-ui, sans-serif; font-size: 8pt; color: #888; text-transform: lowercase; }
.rp-section-props { display: flex; flex-wrap: wrap; gap: 3mm 8mm; margin: 0 0 6mm; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 9pt; }
.rp-section-props dt { margin: 0; color: #888; }
.rp-section-props dt::after { content: ":"; }
.rp-section-props dd { margin: 0 0 0 4px; display: inline; color: #333; font-weight: 600; }
.rp-section-props dt, .rp-section-props dd { display: inline-block; }
.rp-body h3 { font-size: 13pt; margin: 16px 0 4px; }
.rp-body h4 { font-size: 11.5pt; margin: 14px 0 4px; }
.rp-body h5, .rp-body h6 { font-size: 11pt; margin: 12px 0 4px; }
.rp-body p { margin: 0 0 10px; }
.rp-body ul, .rp-body ol { margin: 0 0 10px; padding-left: 1.6em; }
.rp-body li { margin: 3px 0; }
.rp-body li.rp-task { list-style: none; margin-left: -1.2em; }
.rp-check { display: inline-block; width: 10px; height: 10px; margin-right: 7px; border: 1px solid #555; border-radius: 2px; vertical-align: middle; }
.rp-check[data-on="yes"] { background: #555; }
.rp-body code { font-family: ui-monospace, Consolas, monospace; font-size: .9em; background: #f2f2f2; padding: 0 3px; border-radius: 3px; }
.rp-body pre { background: #f5f5f5; border: 1px solid #e2e2e2; border-radius: 4px; padding: 10px 12px; font: 9pt/1.45 ui-monospace, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 12px; }
.rp-body blockquote { margin: 0 0 12px; padding-left: 12px; border-left: 3px solid #ccc; color: #444; }
.rp-hl { background: #fff2a8; padding: 0 2px; }
.rp-table { width: 100%; border-collapse: collapse; margin: 0 0 12px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 9.5pt; }
.rp-table th, .rp-table td { padding: 5px 8px; text-align: left; vertical-align: top; overflow-wrap: anywhere; border-bottom: 1px solid #e2e2e2; }
.rp-table th { font-weight: 600; border-bottom: 1.5px solid #999; }
.rp-img { display: block; max-width: 100%; max-height: 240mm; width: auto; height: auto; object-fit: contain; margin: 6px 0 12px; }
.rp-diagram { display: block; margin: 6px auto 12px; max-width: 100%; max-height: 230mm; height: auto; object-fit: contain; }
.rp-img-missing { margin: 6px 0 12px; color: #999; font-style: italic; font-size: 10pt; }
.rp-rule { border: 0; border-top: 1px solid #ccc; margin: 24px 0; }

/* Each sheet owns its footer, outside its measured content area. */
.rp-doc .rp-footer { position: absolute; left: 18mm; right: 18mm; bottom: 10mm; display: flex; align-items: center; gap: 6mm; padding-top: 3mm; border-top: 1px solid #ddd; color: #777; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 8pt; line-height: 1.3; }
.rp-doc .rp-footer-branding { display: flex; align-items: center; gap: 3mm; min-width: 0; flex: 1; overflow-wrap: anywhere; }
.rp-doc .rp-footer[data-align="right"] .rp-footer-branding { justify-content: flex-end; text-align: right; }
.rp-doc .rp-footer[data-align="left"] .rp-footer-branding { justify-content: flex-start; text-align: left; }
.rp-doc .rp-page-number { flex: none; white-space: nowrap; font-variant-numeric: tabular-nums; }
.rp-footer-logo { max-height: 11mm; max-width: 42mm; width: auto; object-fit: contain; }
.rp-footer-note { min-width: 0; }

/* Physical margins are repeated INSIDE EVERY explicit A4 sheet. */
@page { size: A4; margin: 0; }
@media print {
  body > *:not(#rp-print-host) { display: none !important; }
  html, body { margin: 0 !important; padding: 0 !important; width: auto !important; height: auto !important; overflow: visible !important; }
  #rp-print-host, #rp-print-host .rp-doc { display: block; }
  #rp-print-host { margin: 0; padding: 0; }
  .rp-doc { margin: 0; padding: 0; }
  .rp-page { margin: 0; box-shadow: none; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
}
/* end palette-exempt */
`;

// --------------------------------------------------------------------- plugin

export default {
  manifest: {
    id: "notible.reportit",
    name: "ReportIt",
    version: "0.1.15",
    apiVersion: "1.14",
    description: "Assemble chosen notes, issues and tasks — any types, any order — into one uniform report with a title you set, and print it to PDF. It never changes your notes: it lays out their titles and bodies as a coherent document with a cover, a table of contents and consistent typography. For a client or a manager, not a raw export.",
    author: "Notible",
    permissions: ["data.read", "media.read", "workspace.ui"],
  },

  onload(context) {
    this._disposables = [];
    this._disposables.push(context.views.register({
      id: "builder",
      title: "ReportIt",
      nav: true,
      navIcon: "file-text",
      mount: (host) => mountSurface(context, host),
    }));
  },

  onunload() {
    for (const disposable of this._disposables ?? []) disposable.dispose?.();
    this._disposables = [];
  },
};
