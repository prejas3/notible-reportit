/**
 * Runnable check for ReportIt's pure functions — the markdown AST pipeline,
 * heading normalisation, media-reference collection, and the report model.
 * The DOM layer and the print flow need a DOM this check does not have, so
 * they are asserted against the source instead.
 *
 * node plugins/notible-reportit/self-check.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import plugin, {
  buildTocModel,
  collectProperties,
  mediaRefsIn,
  mimeForExt,
  normalizeHeadings,
  parseInline,
  renderMarkdown,
  reportModel,
  tiptapToMarkdown,
} from "./main.js";

const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");

// --- identity
const declared = JSON.parse(readFileSync(new URL("./plugin.json", import.meta.url), "utf8"));
assert.ok(plugin.manifest, "the entry module must export a manifest");
for (const field of ["id", "name", "version", "apiVersion", "description", "author"]) {
  assert.equal(plugin.manifest[field], declared[field], `${field} must match plugin.json`);
}
assert.equal(declared.apiVersion, "1.14", "media.read is 1.14; a plugin that uses it must say so");
assert.deepEqual([...declared.permissions].sort(), ["data.read", "media.read", "workspace.ui"]);
assert.equal(typeof plugin.onload, "function");
assert.equal(typeof plugin.onunload, "function");

// --- parseInline: links and wikilinks reduce to visible text
assert.deepEqual(parseInline("plain"), [{ kind: "text", text: "plain" }]);
assert.deepEqual(parseInline("see [the docs](https://x)"), [{ kind: "text", text: "see " }, { kind: "text", text: "the docs" }]);
assert.deepEqual(parseInline('a [t](u "title") b'), [{ kind: "text", text: "a " }, { kind: "text", text: "t" }, { kind: "text", text: " b" }]);
assert.deepEqual(parseInline("a [[Design Notes]] b"), [{ kind: "text", text: "a " }, { kind: "text", text: "Design Notes" }, { kind: "text", text: " b" }]);
assert.deepEqual(parseInline("mid ![alt](media/x.png) line"), [{ kind: "text", text: "mid " }, { kind: "text", text: "alt" }, { kind: "text", text: " line" }], "a mid-line image reduces to its alt text");
assert.deepEqual(parseInline("**bold** and *em* and `code` and ==hl=="), [
  { kind: "strong", text: "bold" }, { kind: "text", text: " and " },
  { kind: "em", text: "em" }, { kind: "text", text: " and " },
  { kind: "code", text: "code" }, { kind: "text", text: " and " },
  { kind: "hl", text: "hl" },
]);
assert.deepEqual(parseInline("`*not italic*`"), [{ kind: "code", text: "*not italic*" }], "no emphasis parse inside code");
// underscores inside a word are literal (job names like SET_LD_TO_PLANNED)
assert.deepEqual(parseInline("job SET_LD_TO_PLANNED ran"), [{ kind: "text", text: "job SET_LD_TO_PLANNED ran" }], "intraword underscores are not emphasis");
assert.deepEqual(parseInline("an _emphasised_ word"), [{ kind: "text", text: "an " }, { kind: "em", text: "emphasised" }, { kind: "text", text: " word" }], "word-flanked underscore emphasis still parses");

// --- renderMarkdown: one case per block kind
const heading = renderMarkdown("# Title")[0];
assert.deepEqual(heading, { kind: "heading", level: 1, inline: [{ kind: "text", text: "Title" }] });
assert.equal(renderMarkdown("###### deep")[0].level, 6);

assert.deepEqual(renderMarkdown("just a paragraph")[0], { kind: "para", inline: [{ kind: "text", text: "just a paragraph" }] });
assert.equal(renderMarkdown("line one\nline two")[0].inline.map((s) => s.text).join(""), "line one line two", "soft-wrapped lines join into one paragraph");

const list = renderMarkdown("- one\n- two")[0];
assert.equal(list.kind, "list");
assert.equal(list.ordered, false);
assert.equal(list.items.length, 2);
assert.equal(renderMarkdown("1. a\n2. b")[0].ordered, true);

const tasks = renderMarkdown("- [ ] open\n- [x] done\n- plain")[0];
assert.equal(tasks.items[0].checked, false);
assert.equal(tasks.items[1].checked, true);
assert.equal(tasks.items[2].checked, null, "a non-task item carries checked: null");

const code = renderMarkdown("```\nconst x = *1*;\n# not a heading\n```")[0];
assert.deepEqual(code, { kind: "code", text: "const x = *1*;\n# not a heading" }, "fenced content is verbatim, no inline or block parsing");

const quote = renderMarkdown("> a quote\n> over two lines")[0];
assert.equal(quote.kind, "quote");
assert.equal(quote.blocks[0].kind, "para");

assert.deepEqual(renderMarkdown("---")[0], { kind: "hr" });
assert.deepEqual(renderMarkdown("***")[0], { kind: "hr" });

const image = renderMarkdown("![a screenshot](media/11111111-2222-3333-4444-555555555555.png)")[0];
assert.deepEqual(image, { kind: "image", src: "media/11111111-2222-3333-4444-555555555555.png", alt: "a screenshot" });

// Notible stores images with no blank line around them — a paragraph must not
// swallow the next line when it is entirely an image.
const packed = renderMarkdown("some text\n![shot](media/11111111-1111-1111-1111-111111111111.png)\nmore text");
assert.deepEqual(packed.map((b) => b.kind), ["para", "image", "para"], "a tightly-packed image is still its own block");

// raw HTML in content is not markup — it becomes paragraph text
const rawHtml = renderMarkdown('<img src="media/11111111-2222-3333-4444-555555555555.png">')[0];
assert.equal(rawHtml.kind, "para");
assert.ok(rawHtml.inline.some((s) => s.text.includes("<img")), "a raw <img> line survives as literal text, not an image block");

// untrusted / malformed input must not throw
assert.deepEqual(renderMarkdown(null), []);
assert.deepEqual(renderMarkdown(""), []);
assert.doesNotThrow(() => renderMarkdown("#### \n\n> \n\n- \n\n```\nunclosed"));

// --- tiptapToMarkdown: a legacy Tiptap doc flattens; plain markdown passes through
assert.equal(tiptapToMarkdown("## already markdown\n\ntext"), "## already markdown\n\ntext", "a non-JSON string is returned unchanged");
assert.equal(tiptapToMarkdown("{not json"), "{not json", "an unparseable string is returned unchanged");
assert.equal(tiptapToMarkdown('{"type":"other"}'), '{"type":"other"}', "JSON that is not a doc is returned unchanged");
const legacy = JSON.stringify({
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Case description" }] },
    { type: "paragraph", content: [{ type: "text", text: "plain " }, { type: "text", text: "bold", marks: [{ type: "bold" }] }, { type: "text", text: " end" }] },
    { type: "codeBlock", attrs: { language: "sql" }, content: [{ type: "text", text: "SELECT 1;" }] },
    { type: "image", attrs: { src: "media/11111111-1111-1111-1111-111111111111.png", alt: "shot" } },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }] },
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "done" }] }] }] },
  ],
});
const asMd = tiptapToMarkdown(legacy);
assert.ok(asMd.includes("## Case description"));
assert.ok(asMd.includes("plain **bold** end"), "inline marks survive the conversion");
assert.ok(asMd.includes("```sql\nSELECT 1;\n```"));
assert.ok(asMd.includes("![shot](media/11111111-1111-1111-1111-111111111111.png)"));
assert.ok(asMd.includes("- one"));
assert.ok(asMd.includes("- [x] done"));
// and the converted markdown feeds the normal parser to a real AST
const legacyBlocks = renderMarkdown(tiptapToMarkdown(legacy));
assert.deepEqual(legacyBlocks.map((b) => b.kind), ["heading", "para", "code", "image", "list"]);
assert.equal(legacyBlocks[0].level, 2);
const legacyList = legacyBlocks[4];
assert.equal(legacyList.items[0].checked, null, "the bullet item stays a plain item");
assert.equal(legacyList.items[1].checked, true, "the task item keeps its ticked state");

// --- normalizeHeadings: one pass, no double-map
const norm = normalizeHeadings([
  { kind: "heading", level: 1, inline: [] },
  { kind: "heading", level: 2, inline: [] },
  { kind: "heading", level: 3, inline: [] },   // the case a sequential map breaks
  { kind: "heading", level: 5, inline: [] },
  { kind: "heading", level: 6, inline: [] },
  { kind: "para", inline: [] },
], 2);
assert.deepEqual(norm.map((b) => b.level ?? "para"), [3, 4, 5, 6, 6, "para"]);
const normQuote = normalizeHeadings([{ kind: "quote", blocks: [{ kind: "heading", level: 1, inline: [] }] }], 2);
assert.equal(normQuote[0].blocks[0].level, 3, "headings inside a blockquote are normalised too");

// --- mediaRefsIn
const refBlocks = renderMarkdown([
  "![one](media/11111111-1111-1111-1111-111111111111.png)",
  "",
  "![again](media/11111111-1111-1111-1111-111111111111.png)",
  "",
  "![vector](media/22222222-2222-2222-2222-222222222222.svg)",
  "",
  "![notuuid](media/not-a-uuid.png)",
  "",
  "![remote](https://host/media/33333333-3333-3333-3333-333333333333.png)",
].join("\n"));
assert.deepEqual(mediaRefsIn(refBlocks), ["media/11111111-1111-1111-1111-111111111111.png"], "only embeddable media refs, deduped; svg, non-uuid and remote excluded");
assert.deepEqual(mediaRefsIn([]), []);

// --- mimeForExt
assert.equal(mimeForExt("media/x.png"), "image/png");
assert.equal(mimeForExt("y.JPG"), "image/jpeg");
assert.equal(mimeForExt("z.webp"), "image/webp");
assert.throws(() => mimeForExt("a.svg"), /no MIME type/, "SVG is refused");
assert.throws(() => mimeForExt("a.txt"), /no MIME type/);

// --- buildTocModel / reportModel
assert.deepEqual(buildTocModel(["A", "B", "C"]), ["A", "B", "C"]);
const model = reportModel({
  title: "  Q3 Review  ",
  description: "",
  dateText: "1 September 2026",
  sections: [
    { title: "First", type: "note", blocks: [{ kind: "para", inline: [] }] },
    { title: "", type: "issue", blocks: [] },
  ],
});
assert.equal(model.cover.title, "Q3 Review");
assert.equal(model.cover.description, "");
assert.deepEqual(model.toc, ["First", "Untitled"]);
assert.equal(model.sections.length, 2);
assert.equal(model.sections[1].title, "Untitled");
assert.equal(reportModel({}).cover.title, "Report", "an empty title falls back");

// --- optional page footer
assert.deepEqual(reportModel({}).footer, { note: "", logoUri: "", align: "right", pageNumbers: false }, "no footer by default");
const footed = reportModel({ footer: { note: "  Confidential  ", logoUri: "data:image/png;base64,AAAA" } });
assert.deepEqual(footed.footer, { note: "Confidential", logoUri: "data:image/png;base64,AAAA", align: "right", pageNumbers: false });
assert.equal(reportModel({ footer: { align: "left", pageNumbers: true } }).footer.pageNumbers, true);
assert.equal(reportModel({ footer: { align: "left" } }).footer.align, "left");
assert.equal(reportModel({ footer: { align: "invalid" } }).footer.align, "right");
assert.deepEqual(reportModel({ coverLogos: ["https://remote/logo.png", "data:image/svg+xml;base64,AAAA"] }).cover.logos, []);
assert.equal(reportModel({ coverLogos: Array(3).fill("data:image/png;base64,AAAA") }).cover.logos.length, 2);
assert.equal(reportModel({ footer: { logoUri: "https://evil/logo.png" } }).footer.logoUri, "", "a non-data: logo URL is rejected");
assert.equal(reportModel({ footer: { note: 5 } }).footer.note, "5");

// --- the DOM layer and print flow, asserted against the source
for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
  assert.ok(!source.includes(banned), `${banned} must not appear: titles and bodies are untrusted text`);
}
assert.ok(source.includes("createElement") && source.includes("textContent"), "the DOM is built from elements, not markup strings");
assert.ok(source.includes("context.views.register({") && /views\.register\(\{[\s\S]{0,160}mount:/.test(source), "the surface is a registered view with a mount");
assert.ok(/navIcon: "file-text"/.test(source), "the nav card uses the 1.14 file-text icon");
assert.ok(source.includes("context.data.media.read"), "images come through the 1.14 media API");
assert.ok(source.includes("@page") && source.includes("break-after: page"), "the print stylesheet sets A4 and page breaks");
assert.ok(/@page\s*\{[^}]*margin:\s*0/.test(source), "the print page has margin:0 so Chromium adds no URL/date/page-number chrome");
assert.ok(source.includes("rp-footer") && source.includes("position: absolute") && source.includes("FileReader"), "each sheet owns its footer and locally-read logo");
assert.ok(source.includes("window.print") && source.includes("afterprint"), "printing is window.print with an afterprint restore");
assert.ok(source.includes('el("div", { id: "rp-print-host" })') || source.includes('id: "rp-print-host"'), "the document is reparented to a top-level host for printing");
assert.ok(source.includes("IMAGE_BUDGET_BYTES") && source.includes("IMAGE_CONCURRENCY"), "image reads are bounded by a byte budget and a concurrency cap");
assert.ok(source.includes("limit: 5000") && source.includes("pool.length === 5000"), "the 5000-row query cap is surfaced, not swallowed");
assert.ok(source.includes('addEventListener("pointerdown"') && source.includes('addEventListener("pointermove", move)') && !source.includes('draggable'), "reorder is pointer-drag (HTML5 DnD is dead in the Tauri webview)");
assert.ok(source.includes("reportit-move") && source.includes("movePick("), "the pick list also has explicit up/down buttons, not drag only");
assert.ok(!source.includes("context.storage") && !source.includes("data.write"), "no cross-session persistence, no writes: builder state is a module-scoped var only");
assert.ok(/let builderMemory = null;/.test(source) && source.includes("saveMemory()"), "the builder restores this session's last title/filters/selection from an in-memory var");

// --- collectProperties: schema fields + per-note ad-hoc _customFields
const typesByName = new Map([
  ["issue", { name: "issue", schema: JSON.stringify({ fields: { severity: { type: "select", options: ["low", "high"] } } }) }],
]);
const propPool = [
  { id: "1", type: "issue", props: JSON.stringify({ severity: "high", _customFields: [{ key: "custom_sf", label: "SF case number", type: "text" }], custom_sf: "SF-100" }) },
  { id: "2", type: "issue", props: JSON.stringify({ _customFields: [{ key: "custom_jira", label: "JIRA case number", type: "text" }], custom_jira: "JIRA-9" }) }, // no severity set
  { id: "3", type: "note", props: "{}" }, // nothing at all
];
const { catalog, valuesById } = collectProperties(propPool, typesByName);
assert.deepEqual(catalog.sort((a, b) => a.key.localeCompare(b.key)), [
  { key: "custom_jira", label: "JIRA case number" },
  { key: "custom_sf", label: "SF case number" },
  { key: "severity", label: "Severity" },
], "the catalog is the union of schema fields and ad-hoc custom fields across the pool, deduplicated by key");
assert.deepEqual(valuesById.get("1"), { severity: "high", custom_sf: "SF-100" }, "a note's own values only, empty/unset keys absent");
assert.deepEqual(valuesById.get("2"), { custom_jira: "JIRA-9" }, "severity is unset on this note and is not reported as a value");
assert.ok(!valuesById.has("3"), "a note with no property values at all is absent, not an empty object");

// --- reportModel: section properties render only what's present, blank ones dropped
const withProps = reportModel({
  sections: [
    { title: "Case A", properties: [{ label: "SF case number", value: "SF-100" }, { label: "JIRA case number", value: "  " }] },
    { title: "Case B" }, // no properties key at all
  ],
});
assert.deepEqual(withProps.sections[0].properties, [{ label: "SF case number", value: "SF-100" }], "a blank value is dropped, not printed as an empty line");
assert.deepEqual(withProps.sections[1].properties, [], "a section with no properties input normalises to an empty list");

// --- builder filters
assert.ok(source.includes("filters.tag") && source.includes('"Any tag"') && source.includes("o.tags.includes(filters.tag)"), "the pool can be filtered by a props tag");
assert.ok(source.includes("const matchesFilters =") && source.includes("selectAll.indeterminate") && source.includes('textContent: "Clear selection"'), "tri-state selection of filtered objects, and clear");
assert.ok(source.includes("readTags(o.props)"), "pool rows carry their tags, read from props");

console.log("Notible ReportIt self-check passed.");
