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
//   | { kind: "code", text: string }
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

/** One markdown string → Block[]. Minimal by design: the constructs a note
 *  actually carries, everything else degrading to paragraph text rather than
 *  throwing. */
export function renderMarkdown(md) {
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  const isBlank = (s) => s.trim() === "";
  const listMatch = (s) => s.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);

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
      blocks.push({ kind: "code", text: body.join("\n") });
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
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    // paragraph — gather until a blank line, the start of another block, or a
    // line that is entirely an image (Notible stores `![](media/…)` with no
    // blank line around it, and we want it as its own block, not swallowed
    // into the paragraph and reduced to alt text).
    const standaloneImage = (s) => /^!\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\)$/.test(s.trim());
    const startsBlock = (s) => isBlank(s) || /^(#{1,6}\s|\s*>|\s*(`{3,}|~{3,}))/.test(s) || !!listMatch(s) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(s) || standaloneImage(s);
    const para = [];
    while (i < lines.length && !startsBlock(lines[i])) {
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

/** The table of contents is section titles, in order — no page numbers (the
 *  print engine cannot tell us where pages land). */
export function buildTocModel(sectionTitles) {
  return (Array.isArray(sectionTitles) ? sectionTitles : []).map((title) => String(title ?? "Untitled"));
}

/** The whole report as a plain object the DOM layer renders. Not a string,
 *  not DOM — serialisable, so the node test can assert on it. */
export function reportModel({ title, description, dateText, sections, footer }) {
  const list = Array.isArray(sections) ? sections : [];
  const normalized = list.map((s) => ({
    title: String(s.title ?? "").trim() || "Untitled",
    type: String(s.type ?? ""),
    blocks: Array.isArray(s.blocks) ? s.blocks : [],
  }));
  const f = footer && typeof footer === "object" ? footer : {};
  return {
    cover: {
      title: String(title ?? "").trim() || "Report",
      dateText: String(dateText ?? ""),
      description: String(description ?? "").trim(),
    },
    toc: buildTocModel(normalized.map((s) => s.title)),
    sections: normalized,
    // Optional running footer (repeats on every printed page): a short note
    // ("Confidential") and/or a small logo. `logoUri` must be a data: image —
    // it is read from a local file client-side, never a remote URL.
    footer: {
      note: String(f.note ?? "").trim(),
      logoUri: typeof f.logoUri === "string" && f.logoUri.startsWith("data:image/") ? f.logoUri : "",
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
    } else if (block.kind === "code") {
      const pre = document.createElement("pre");
      pre.textContent = String(block.text ?? "");
      frag.append(pre);
    } else if (block.kind === "quote") {
      const bq = document.createElement("blockquote");
      bq.append(renderBlocks(block.blocks, dataUris));
      frag.append(bq);
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

/** The model + resolved image data URIs → the `<article class="rp-doc">`. */
function renderReport(model, dataUris) {
  const doc = el("article", { className: "rp-doc" });

  const cover = el("header", { className: "rp-cover" }, [
    el("h1", { className: "rp-title", textContent: model.cover.title }),
    el("p", { className: "rp-date", textContent: model.cover.dateText }),
  ]);
  if (model.cover.description) {
    cover.append(el("p", { className: "rp-desc", textContent: model.cover.description }));
  }
  doc.append(cover);

  const toc = el("nav", { className: "rp-toc" }, [el("h2", { textContent: "Contents" })]);
  const ol = document.createElement("ol");
  for (const title of model.toc) ol.append(el("li", { textContent: title }));
  toc.append(ol);
  doc.append(toc);

  model.sections.forEach((section, index) => {
    const sec = el("section", { className: "rp-section" }, [
      el("h2", { className: "rp-section-title", textContent: section.title }),
    ]);
    if (section.type) sec.append(el("p", { className: "rp-section-type", textContent: section.type }));
    if (section.blocks.length) {
      const body = el("div", { className: "rp-body" });
      body.append(renderBlocks(section.blocks, dataUris));
      sec.append(body);
    }
    doc.append(sec);
    if (index < model.sections.length - 1) doc.append(el("hr", { className: "rp-rule" }));
  });

  const footer = model.footer ?? { note: "", logoUri: "" };
  if (footer.note || footer.logoUri) {
    const foot = el("footer", { className: "rp-footer" });
    if (footer.logoUri) {
      const logo = el("img", { className: "rp-footer-logo", alt: "" });
      logo.src = footer.logoUri;
      foot.append(logo);
    }
    if (footer.note) foot.append(el("span", { className: "rp-footer-note", textContent: footer.note }));
    doc.append(foot);
  }

  return doc;
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
  return raw.includes(".") ? raw.slice(raw.lastIndexOf(".") + 1) : raw;
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
  shell.append(el("p", { className: "rp-note", textContent: "Reading the workspace…" }));

  // reparent-print teardown state, set up once
  let printHost = null;
  let savedDocTitle = null;
  const restorePrint = () => {
    if (printHost) {
      preview.append(printHost.firstChild);
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
    try {
      objects = await context.data.objects.query({ limit: 5000 });
    } catch (cause) {
      if (!disposed) shell.replaceChildren(el("p", { className: "rp-note", textContent: String(cause?.message ?? cause) }));
      return;
    }
    if (disposed) return;

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
    }));
    const byId = new Map(pool.map((o) => [o.id, o]));
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
    const selectedIds = Array.isArray(mem.selectedIds) ? mem.selectedIds.filter((id) => pool.some((o) => o.id === id)) : []; // ordered
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
        types: [...filters.types],
        container: filters.container,
        search: filters.search,
        tag: filters.tag,
        selectedIds: [...selectedIds],
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
    const containerSel = el("select", { className: "reportit-select" });
    containerSel.append(el("option", { value: "", textContent: "Any container" }));
    for (const [pid, title] of [...parentTitles].sort((a, b) => a[1].localeCompare(b[1]))) {
      containerSel.append(el("option", { value: pid, textContent: title }));
    }
    containerSel.value = filters.container;
    filters.container = containerSel.value; // drop a remembered id that no longer resolves
    containerSel.addEventListener("change", () => { filters.container = containerSel.value; renderPool(); });
    // Tag filter: union of every object's props.tags. Hidden entirely when the
    // workspace has no tags, so it does not add a dead control to the bar.
    const allTags = [...new Set(pool.flatMap((o) => o.tags))].sort((a, b) => a.localeCompare(b));
    const tagSel = el("select", { className: "reportit-select" });
    tagSel.append(el("option", { value: "", textContent: "Any tag" }));
    for (const tag of allTags) tagSel.append(el("option", { value: tag, textContent: tag }));
    tagSel.value = allTags.includes(filters.tag) ? filters.tag : "";
    filters.tag = tagSel.value;
    tagSel.hidden = allTags.length === 0;
    tagSel.addEventListener("change", () => { filters.tag = tagSel.value; renderPool(); });
    const searchInput = el("input", { className: "reportit-search", type: "search", placeholder: "Search titles…" });
    searchInput.value = filters.search;
    searchInput.addEventListener("input", () => { filters.search = searchInput.value.trim().toLowerCase(); renderPool(); });
    filterBar.append(typeChips, containerSel, tagSel, searchInput);
    const poolCount = el("span", { className: "reportit-count" });
    poolCol.append(
      el("h3", { className: "reportit-col-head reportit-pool-head" }, [textNode("Workspace"), poolCount]),
      filterBar,
    );

    const poolList = el("div", { className: "reportit-list" });
    poolCol.append(poolList);
    const addAllBtn = el("button", { type: "button", className: "reportit-bulk", textContent: "Add all matching" });
    const clearBtn = el("button", { type: "button", className: "reportit-bulk", textContent: "Clear selection" });
    poolCol.append(el("div", { className: "reportit-bulkrow" }, [addAllBtn, clearBtn]));

    const matchesFilters = (o) => {
      if (filters.types.size && !filters.types.has(o.type)) return false;
      if (filters.container && o.parentId !== filters.container) return false;
      if (filters.tag && !o.tags.includes(filters.tag)) return false;
      if (filters.search && !o.title.toLowerCase().includes(filters.search)) return false;
      return true;
    };

    addAllBtn.addEventListener("click", () => {
      for (const o of pool.filter(matchesFilters)) if (!selectedIds.includes(o.id)) selectedIds.push(o.id);
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
      addAllBtn.disabled = unpicked === 0;
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
    pickCol.append(el("h3", { className: "reportit-col-head" }, [textNode("Report"), pickCount]));
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
    const logoInput = el("input", { className: "reportit-logo-input", type: "file", accept: "image/png,image/jpeg,image/webp,image/gif" });
    const logoPreview = el("img", { className: "reportit-logo-preview", alt: "", hidden: true });
    const logoClear = el("button", { type: "button", className: "reportit-bulk", textContent: "Remove logo", hidden: true });
    const syncLogo = () => {
      logoPreview.hidden = !footerLogoUri;
      if (footerLogoUri) logoPreview.src = footerLogoUri;
      logoClear.hidden = !footerLogoUri;
    };
    logoInput.addEventListener("change", () => {
      const file = logoInput.files && logoInput.files[0];
      logoInput.value = "";
      if (!file) return;
      if (file.size > 512 * 1024) { context.ui.notice("Footer logo must be under 512 KB."); return; }
      const reader = new FileReader();
      reader.onload = () => { footerLogoUri = String(reader.result || ""); saveMemory(); syncLogo(); };
      reader.onerror = () => context.ui.notice("Could not read that image.");
      reader.readAsDataURL(file);
    });
    logoClear.addEventListener("click", () => { footerLogoUri = ""; saveMemory(); syncLogo(); });
    footerFields.append(footerNoteInput, el("div", { className: "reportit-logo-row" }, [logoInput, logoPreview, logoClear]));
    pickCol.append(footerFields);
    syncLogo();
    const pickList = el("div", { className: "reportit-list reportit-picklist" });
    pickCol.append(pickList);
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

    // pointer-drag reorder (HTML5 DnD is dead in the Tauri webview)
    let drag = null;
    function renderPicks() {
      pickList.replaceChildren();
      selectedIds.forEach((id, index) => {
        const o = byId.get(id);
        if (!o) return;
        const row = el("div", { className: "reportit-pickrow" });
        row.dataset.index = String(index);
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
          drag = { from: index };
          row.dataset.dragging = "yes";
          const move = (moveEvent) => {
            const over = moveEvent.target instanceof Element ? moveEvent.target.closest(".reportit-pickrow") : null;
            for (const r of pickList.children) delete r.dataset.dropTarget;
            if (over && over !== row) over.dataset.dropTarget = "yes";
          };
          const up = (upEvent) => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            delete row.dataset.dragging;
            const over = upEvent.target instanceof Element ? upEvent.target.closest(".reportit-pickrow") : null;
            if (over && over !== row) {
              const to = Number(over.dataset.index);
              const [moved] = selectedIds.splice(drag.from, 1);
              selectedIds.splice(to, 0, moved);
              renderPicks();
            } else {
              for (const r of pickList.children) delete r.dataset.dropTarget;
            }
            drag = null;
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
      if (!selectedIds.length) pickList.append(el("p", { className: "rp-note", textContent: "Tick objects on the left, or use “Add all matching”." }));
      pickCount.textContent = selectedIds.length ? `${selectedIds.length}` : "";
      updateGenerateEnabled();
      saveMemory();
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

    editBtn.addEventListener("click", () => { previewWrap.hidden = true; builder.hidden = false; });

    printBtn.addEventListener("click", () => {
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
      generateBtn.disabled = true;
      genNote.textContent = "Building the report…";
      const sections = selectedIds.map((id) => {
        const o = byId.get(id);
        return { title: o.title, type: typeLabel(o.type), blocks: normalizeHeadings(renderMarkdown(tiptapToMarkdown(o.content))) };
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

      const model = reportModel({
        title: titleInput.value,
        description: descInput.value,
        dateText: formatDate(new Date()),
        sections,
        footer: { note: footerNoteInput.value, logoUri: footerLogoUri },
      });
      preview.replaceChildren(renderReport(model, result.uris));

      const noteParts = [];
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
      generateBtn.disabled = false;
      genNote.textContent = "";
    });

    renderPool();
    renderPicks();
  })();

  return {
    dispose: () => {
      disposed = true;
      window.removeEventListener("afterprint", onAfterPrint);
      restorePrint();
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
.reportit-shell { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.rp-note { margin: 0; color: var(--notible-muted); font-size: 12px; line-height: 1.5; }

.reportit-builder { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; align-items: start; min-height: 0; }
@media (max-width: 900px) { .reportit-builder { grid-template-columns: 1fr; } }
.reportit-col { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.reportit-col-head { margin: 0; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--notible-muted); }
.reportit-count { margin-left: 6px; color: var(--notible-faint); font-weight: 500; }
.reportit-count:empty { display: none; }
.reportit-bulkrow { display: flex; gap: 8px; }
.reportit-bulk { border: 1px solid var(--notible-border); border-radius: 7px; background: transparent; color: var(--notible-muted); font: inherit; font-size: 12px; padding: 4px 10px; cursor: pointer; }
.reportit-bulk:hover:not(:disabled) { background: var(--notible-hover); }
.reportit-bulk:disabled { opacity: .45; cursor: default; }
.reportit-move { flex: none; border: 0; background: none; color: var(--notible-muted); cursor: pointer; font-size: 10px; line-height: 1; padding: 2px 3px; }
.reportit-move:disabled { opacity: .3; cursor: default; }
.reportit-filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.reportit-typechips { display: flex; flex-wrap: wrap; gap: 6px; }
.reportit-chip { border: 1px solid var(--notible-border); border-radius: 7px; background: transparent; color: var(--notible-muted); font: inherit; font-size: 12px; padding: 3px 9px; cursor: pointer; }
.reportit-chip:hover { border-color: var(--notible-accent); color: var(--notible-text); }
.reportit-chip[data-on="yes"] { border-color: var(--notible-accent); background: var(--notible-selected); color: var(--notible-accent); }
.reportit-select, .reportit-search, .reportit-title-input, .reportit-desc-input { min-width: 0; border: 1px solid var(--notible-border); border-radius: 7px; background: var(--notible-surface); color: var(--notible-text); font: inherit; font-size: 12px; padding: 6px 9px; }
.reportit-desc-input { resize: vertical; }
.reportit-list { display: flex; flex-direction: column; gap: 2px; max-height: 46vh; overflow-y: auto; border: 1px solid var(--notible-border-subtle, var(--notible-border)); border-radius: 8px; padding: 4px; }
.reportit-poolrow { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 6px; cursor: pointer; }
.reportit-poolrow:hover { background: var(--notible-hover); }
.reportit-poolrow-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reportit-poolrow-type, .reportit-pickrow-type { flex: none; color: var(--notible-faint); font-size: 11px; }
.reportit-pickrow { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 6px; background: transparent; }
.reportit-pickrow:hover { background: var(--notible-hover); }
.reportit-pickrow[data-dragging="yes"] { opacity: .5; }
.reportit-pickrow[data-drop-target="yes"] { box-shadow: inset 0 2px 0 var(--notible-accent); }
.reportit-pickrow-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reportit-grip { flex: none; border: 0; background: none; color: var(--notible-muted); cursor: grab; font-size: 13px; padding: 2px 4px; }
.reportit-remove { flex: none; border: 0; background: none; color: var(--notible-faint); cursor: pointer; font-size: 14px; padding: 2px 6px; }
.reportit-remove:hover { color: var(--notible-danger); }
.reportit-generate, .reportit-print { align-self: flex-start; border: 1px solid var(--notible-accent); border-radius: 7px; background: var(--notible-accent); color: var(--notible-on-accent); font: inherit; font-weight: 600; font-size: 12px; padding: 6px 14px; cursor: pointer; }
.reportit-generate:disabled { opacity: .5; cursor: default; }
.reportit-edit { border: 1px solid var(--notible-border); border-radius: 7px; background: transparent; color: var(--notible-muted); font: inherit; font-size: 12px; padding: 6px 12px; cursor: pointer; }
.reportit-footer-fields { display: flex; flex-direction: column; gap: 6px; margin-top: 2px; border-top: 1px solid var(--notible-border-subtle, var(--notible-border)); padding-top: 8px; }
.reportit-logo-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.reportit-logo-input { font: inherit; font-size: 11px; color: var(--notible-muted); }
.reportit-logo-preview { max-height: 26px; max-width: 90px; object-fit: contain; border: 1px solid var(--notible-border-subtle, var(--notible-border)); border-radius: 4px; }
.reportit-preview-wrap { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.reportit-preview-bar { display: flex; gap: 10px; align-items: center; }
/* No card here — the report sheet floats on the workspace background like the
   rest of the plugin chrome. Padding is just breathing room around the sheet. */
.reportit-preview { padding: 24px 0; background: transparent; overflow: auto; max-height: 68vh; }

/* palette-exempt: the report is a fixed light document (black on white,
   always), not a themed surface — its colour literals are intentional and
   plugin-css-token-check skips this region. */
.rp-doc { background: #fff; color: #1a1a1a; font-family: Georgia, "Times New Roman", serif; font-size: 11pt; line-height: 1.55; max-width: 210mm; margin: 0 auto; padding: 26mm 22mm; box-shadow: 0 1px 6px rgba(0, 0, 0, .12); }
.rp-doc h1, .rp-doc h2, .rp-doc h3, .rp-doc h4, .rp-doc h5, .rp-doc h6 { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #111; line-height: 1.25; }
.rp-cover { display: flex; flex-direction: column; justify-content: center; padding: 24px 0 32px; }
.rp-title { font-size: 30pt; font-weight: 700; margin: 0 0 10px; }
.rp-date { margin: 0 0 16px; color: #666; font-family: system-ui, sans-serif; font-size: 10pt; }
.rp-desc { margin: 0; max-width: 60ch; color: #333; }
.rp-toc { margin: 0 0 8px; }
.rp-toc h2 { font-size: 15pt; margin: 0 0 8px; }
.rp-toc ol { margin: 0; padding-left: 1.4em; color: #333; }
.rp-toc li { margin: 2px 0; }
.rp-section { margin: 0; }
.rp-section-title { font-size: 15pt; font-weight: 650; margin: 18px 0 0; }
.rp-section-type { margin: 2px 0 10px; font-family: system-ui, sans-serif; font-size: 8pt; color: #888; text-transform: lowercase; }
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
.rp-img { display: block; max-width: 100%; margin: 6px 0 12px; }
.rp-img-missing { margin: 6px 0 12px; color: #999; font-style: italic; font-size: 10pt; }
.rp-rule { border: 0; border-top: 1px solid #ccc; margin: 24px 0; }

/* Optional running footer — repeats on every page in print (position: fixed) */
.rp-footer { display: flex; align-items: center; gap: 10px; margin-top: 30px; padding-top: 10px; border-top: 1px solid #ddd; color: #777; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 8pt; }
.rp-footer-logo { max-height: 11mm; max-width: 42mm; width: auto; object-fit: contain; }
.rp-footer-note { margin-left: auto; text-align: right; }

/* margin:0 here is deliberate: it stops Chromium adding its own page
   header/footer (the URL — "tauri.localhost" — the date and page numbers).
   The paper margin is moved onto the .rp-doc padding below. */
@page { size: A4; margin: 0; }
@media print {
  body > *:not(#rp-print-host) { display: none !important; }
  #rp-print-host, #rp-print-host .rp-doc { display: block; }
  .rp-doc { position: static; box-shadow: none; max-width: none; margin: 0; padding: 18mm 16mm 22mm; }
  .rp-cover { min-height: 76vh; }   /* the cover owns its page on paper */
  .rp-footer { position: fixed; left: 16mm; right: 16mm; bottom: 8mm; margin: 0; background: #fff; }
}
.rp-cover, .rp-toc { break-after: page; }
.rp-section-title, .rp-section-type { break-after: avoid; }
.rp-section { break-inside: auto; }
.rp-body h3, .rp-body h4, .rp-body h5, .rp-body h6 { break-after: avoid; }
.rp-body pre, .rp-body blockquote { break-inside: avoid; }
/* end palette-exempt */
`;

// --------------------------------------------------------------------- plugin

export default {
  manifest: {
    id: "notible.reportit",
    name: "ReportIt",
    version: "0.1.4",
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

