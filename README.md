# ReportIt

Assemble chosen notes, issues and tasks — any types, any order — into one
uniform report with a title you set, and print it to PDF.

It never changes your notes. It reads their titles and bodies and lays them
out as a coherent document: a cover, a table of contents, one section per
object, consistent typography. For a client or a manager, not a raw export.

## Using it

**ReportIt** in the navigation opens the builder.

- **Left — the workspace.** Every object, filtered by type (click the chips),
  by container, or by a title search. Tick the ones the report should contain
  — mix types freely; a "cycle report" can hold tasks and issues from one
  project.
- **Right — the report.** The ticked objects, in order. Drag the `⠿` grip to
  reorder, `×` to drop one. Set a **title** (required) and an optional short
  **description** for the cover.
- **Page footer (optional).** A short note (e.g. `Confidential`) and/or a
  small logo, repeated at the foot of every page. The logo is read from a
  local image file in the browser — nothing is uploaded and nothing is kept
  past the app session. Leave both blank for no footer.
- **Generate report** builds the document and shows it as a preview.
- **Print / Save as PDF** opens the print dialog. Pick "Save as PDF".
- **Edit selection** goes back to the builder with your picks intact.

Nothing is saved. Each run starts from an empty selection.

## What it does to the content

The plugin reformats presentation, never substance:

- **Headings** in a note are pushed down two levels, so they nest under the
  section's own heading (`#` in a note becomes `<h3>` in the report). Anything
  past `<h6>` is flattened to `<h6>`.
- **Links and `[[wikilinks]]`** are reduced to their visible text — a printed
  report has nothing to click.
- **Task checkboxes** (`- [ ]` / `- [x]`) are drawn as a small box, ticked or
  not, matching the note.
- **Images** (`![alt](media/…)`) are embedded from the pasted-image store,
  provided you have enabled **Settings → Files & links → "Let plugins read
  pasted images"**. Without it, or for an image that cannot be read, the spot
  shows `[image unavailable]`. SVG images are not embedded (they can carry
  script). External `http://` images are not fetched (the plugin has no
  network access).
- Bold, italic, inline `code`, fenced code blocks, blockquotes, ordered and
  unordered lists, `==highlight==` and `---` rules all render.
- Markdown tables are not rendered (they degrade to text — no note uses them).

## The document

- A4, ~18 mm margins (as `.rp-doc` padding), always light (black on white)
  regardless of the app theme.
- Serif body (Georgia), sans headings.
- Cover: title, date, optional description — on its own page. Contents on its
  own page. Sections then flow, a thin rule between each.
- Section header: the note's title, and its type in small grey letters.
- No `props` — no status, dates or assignee. Title and body only.
- `@page` margin is `0`, so Chromium prints no header or footer of its own
  (no `tauri.localhost`, no date, no page number). The only footer is the
  optional note/logo above.

## Permissions

| Permission | Why |
|---|---|
| `data.read` | list objects and read their `content` |
| `media.read` | the bytes of a pasted image referenced in a note, to embed it (new in API 1.14; gated on the user's "Let plugins read pasted images" switch) |
| `workspace.ui` | the ReportIt screen |

No `network`, no `data.write`. Nothing leaves the machine.

## How it works

- One `main.js`, no build step, no dependencies. Markdown is parsed to a plain
  AST by a ~150-line parser (the subset above; everything else degrades to a
  paragraph). The AST is turned into DOM with `createElement`/`textContent` —
  never a markup string, because titles and bodies are untrusted text.
- Images are read with a small concurrency and a 48 MB aggregate budget;
  past it, the rest render as placeholders and the preview says so.
- Printing reparents the document to a top-level element under `<body>` so it
  escapes every scrolling/clipping ancestor and the print engine can paginate
  it, then restores it on `afterprint`.

## Check

```
node plugins/notible-reportit/self-check.mjs
```

Covers the pure functions — inline parsing (links reduced to text, no
emphasis inside code), every block kind, heading normalisation in one pass,
media-reference collection (svg / non-uuid / remote excluded), the MIME map,
and the report model — plus source assertions for the DOM layer and the
print flow.

## Install

In Notible: **Settings -> Plugins -> Market**, then install "ReportIt".
This repo is the source; the market pulls `plugin.json` + `notible.reportit.zip` from the latest GitHub Release.
