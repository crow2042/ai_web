# CLAUDE.md

This file is intended for collaborators using **Claude Code** on this repository.

The goal is to help Claude make safe, incremental changes without over-refactoring the project.

## 1. Project Purpose

This repository is a lightweight internal web tool with two major features:

- `AI 生图工作台`
- `Prompt 优化器`

The project is intentionally simple and mostly file-based.

Do **not** treat it like a greenfield rewrite project.

## 2. Core Working Principle

When adding features or optimizations:

- prefer **small patches**
- prefer **backward compatibility**
- prefer **extending existing logic**
- avoid **large rewrites**

If something can be implemented by editing a few existing functions, do that instead of introducing a new architecture.

## 3. High-Priority Constraints

### 3.1 Do not perform large rewrites

Unless the user explicitly asks:

- do not migrate frameworks
- do not replace the page structure wholesale
- do not rename core files
- do not reorganize the repository
- do not do bulk formatting-only edits

### 3.2 Keep existing flows working

These pages must continue to work:

- `/`
- `/image.html`
- `/prompt.html`

Do not break existing admin login, local records, model selection, or prompt handoff flows.

### 3.3 Keep backend implementations aligned

This project has multiple backend implementations:

- `server.js`
- `server.ps1`
- `server.py`

Current real-world usage often relies on:

- `server.ps1` for local Windows runs
- `server.js` for deployment / packaging logic

If request behavior, config schema, or response shape changes, check whether the same change is needed in both:

- `server.js`
- `server.ps1`

Do not update only one unless you are certain the other is intentionally out of scope.

## 4. Repository Areas

### Frontend files

- `public/image.html`
- `public/app.js`
- `public/styles.css`
- `public/prompt.html`
- `public/prompt.js`
- `public/prompt.css`
- `public/index.html`
- `public/hall.css`

### Backend files

- `server.js`
- `server.ps1`
- `server.py`

### Documentation / deployment

- `README.md`
- `README.docx`
- `DEPLOY-UBUNTU.md`
- `scripts/make-readme-docx.ps1`

## 5. Runtime Data Rules

Treat `data/` as runtime state, not as normal source code.

Do **not** casually modify:

- `data/config.json`
- `data/records.jsonl`
- `data/prompt-records.jsonl`
- `data/generations.jsonl`
- `data/generated/`

Do **not** package local runtime data into deploy archives.

## 6. Model Configuration Rules

The project supports model filtering and routing based on task type.

Important concepts:

- `generation`
- `edit`
- plain prompt
- JSON prompt

When changing model configuration logic:

1. Prefer supporting both legacy and new config shapes.
2. Do not break old records or old configs if avoidable.
3. If introducing new fields, keep fallback behavior.

Examples:

- support old `requestMode`
- support newer `requestModes`
- treat missing values conservatively

## 7. Frontend Change Rules

When editing the frontend:

- reuse current DOM structure whenever possible
- keep button ids and selectors stable unless necessary
- avoid unnecessary extra dialogs or nested flows
- preserve current data handoff behavior between pages

Specific examples:

- if changing prompt output behavior, keep jump-to-image handoff working
- if changing generation/edit mode UI, keep model filtering and saved config behavior aligned
- if changing admin forms, make sure saved values can also be read back correctly

## 8. Admin / Config Safety

Admin features are easy to break because they touch:

- frontend form state
- saved config shape
- model filtering logic
- deployment behavior

When editing admin configuration:

always verify all of the following:

1. save works
2. reopen form still shows saved values
3. filtered model lists still work
4. disabled / empty mode behavior is still handled correctly

## 9. Error Handling Guidance

When upstream image providers fail:

- prefer returning readable messages
- do not assume every provider returns the same JSON structure
- handle HTML error pages and non-JSON responses safely
- avoid null-property access chains that throw local wrapper errors

If a provider times out or returns Cloudflare HTML, surface that clearly instead of exposing broken parsing behavior.

## 10. What Claude Should Avoid

Avoid touching these unless explicitly requested:

- deployment zip files
- local preview archives
- temporary restore folders
- unrelated runtime artifacts
- unrelated record/history files

Avoid deleting folders like:

- `$dst/`
- `playground_unpack/`
- `server_restore_tmp/`

unless the user explicitly asks.

## 11. Preferred Change Strategy

When implementing a new request:

1. inspect the current code path
2. patch the smallest number of files possible
3. keep compatibility with current UI and config behavior
4. verify handoff flows still work
5. avoid introducing a second system when the first can be extended

## 12. Before Finishing

Claude should sanity-check:

1. Does `/image.html` still load?
2. Does `/prompt.html` still load?
3. If config behavior changed, do saved values reopen correctly?
4. If task modes changed, do model lists still filter correctly?
5. If output behavior changed, does page-to-page jump still pass prompt and reference images correctly?

## 13. Collaboration Intent

This repository is jointly maintained.

Claude should optimize for:

- understandable diffs
- low-risk patches
- minimal disruption to ongoing work

If in doubt, choose the less invasive implementation.
