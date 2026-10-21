# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

NCHC inference deployment calculator: given a model, a user count and a workload type, it answers how many GPUs each platform (H100, H200, GB200, Mac Studio/mini, DGX Spark) needs, with per-user speed, time to first token, a provenance basis for every number, and a verify command to run on the machine. There is no mode switch: the reverse question (how many users my hardware serves, how fast at my user count) is the count control on that platform's row, and an expanded row is a workbench (speed, TTFT, usage bars, split, cards → speed and users → speed charts, suggested actions, verify command). Users can add custom hardware, models (Hugging Face import or manual), workloads and speed targets, and pin up to 3 setups for comparison. The website (v8) is done; the MCP server (`apps/mcp`) has not been started.

Docs, README, spec and config comments are in Traditional Chinese (zh-TW). Commit messages are in English, conventional-commit style (`feat(web):`, `fix:`, `docs:`, `test(web):`).

## Commands

pnpm workspace (pnpm 12.9.1 via `corepack enable`), Node 24, TypeScript 7, Vitest 5.

```bash
pnpm install
pnpm data:build      # validate config/ → packages/data/dist/bundle.json (fails on any provenance/schema/policy error)
pnpm test            # runs data:build and calibrate, then vitest across all packages
pnpm typecheck       # data:build and calibrate, then tsc -b in every package (the web imports the generated bundle.json and accuracy.json)
pnpm calibrate       # compare predictions with published measurements → packages/data/dist/accuracy.json (out-of-tolerance only WARNs)
pnpm web:dev         # Vite dev server (builds the bundle and accuracy.json first)
pnpm web:build       # static site → packages/web/dist/ (builds the bundle and accuracy.json first)
pnpm web:e2e         # Playwright, desktop + mobile (Pixel 7) projects; builds and serves fresh on :4173
pnpm data:import <owner/repo> --developer <name> --country <ISO2>   # add a model from Hugging Face
pnpm data:snapshot <owner/repo>...   # pin HF responses as replayable test fixtures (test/fixtures/hf/snapshots); --survey <N> re-imports the trending models live
```

Single test: `pnpm vitest run packages/core/test/solve.test.ts` or `pnpm vitest run -t "<test name>"`. Vitest has two projects: `node` (core/data/schema) and `web` (jsdom, `packages/web/vitest.config.ts`); select one with `--project node|web`. Tests import `bundle.json` and `accuracy.json`, so run `pnpm data:build` and `pnpm calibrate` first whenever `config/` changed (plain `pnpm test` / `pnpm typecheck` do this for you). e2e specs (`packages/web/e2e/`): `smoke` (answer, URL round trip, touch), `v8` (screenshots of every state in light and dark, no horizontal scroll at 390/768/1024/1440, values equal core, console clean), `motion` (desktop only: 0/100/200/400 ms frames from the Chrome screencast, reduced motion lands at once); screenshots and frames land in `packages/web/test-results/` and the HTML report.

CI (`.github/workflows/ci.yml`) runs: `typecheck` → `data:build` → `test` → `web:build` → `calibrate`. `web:e2e` is local only (needs browsers).

CD (`.github/workflows/deploy.yml`): every push to `main` reruns `typecheck` and `test`, builds the site and publishes `packages/web/dist` to GitHub Pages (`https://nchc-bio.github.io/inference-calculator/`). Needs the one-time repo setting Settings → Pages → Source: GitHub Actions.

## Architecture

```
config/*.yaml ──data:build──▶ packages/data (validate + provenance) ──▶ bundle.json ──▶ packages/core ──▶ packages/web
Hugging Face ──data:import──▶ config/models/*.yaml
```

- **`config/`** is the only source of data (including `custom-hardware.yaml`, the calibration template platform per engine that custom hardware borrows, and the user-count funnel defaults in `workloads.yaml` `funnel`). Code never hard-codes hardware, model, workload or calibration values. Every numeric field carries `status` (`official | measured | derived | estimate | unverified`), `source` (id in `config/sources.yaml`) and `verified`; `derived` needs a formula and inputs, `estimate` needs a rationale and evidence ids. `data:build` fails if any are missing (spec §2.1, §7).
- **`packages/schema`**: zod schemas and types for config documents and the bundle, including provenance.
- **`packages/data`**: Node-side tooling. `load.ts` reads YAML, `validate.ts` checks schema, references, sourcing and model policy, `build.ts` writes the bundle, `calibrate.ts` writes the accuracy report, `hf-import.ts`/`hf-parse.ts` generate model YAML from HF `config.json` and safetensors index; the Node-free fetch (`hf-fetch.ts`, `fetchHfModel`; the CLI passes the publisher `origin`, the website does not and the model records `UNCHECKED_ORIGIN`) is shared with the browser through the `@nchc/data/hf` subpath; `hf-snapshot.ts` writes the replayable import fixtures.
- **`packages/core`**: pure computation, no Node or DOM APIs; the bundle is passed in. `api.ts` is the public surface (`estimateRequirements` (optional `customPlatforms` → rows `custom:<i>`), `estimateCapacity`, `findFeasibleModels`, `explain`, `verifyCommand`, …); `performance.ts` adds `estimatePerformance` (a catalog platform or `CustomPlatformInput`, a card count, optional TP → every legal split, usage, speed curve) and `estimatePerformanceSweep` (speed over card counts, with the `fastest` ok split per count); `funnel.ts` has `peakConcurrentFromTotal` (total users → peak concurrent, chat workloads only). A model is a catalog id, an override, or `{ imported: { model, source } }` (checked like `data:build`, always warned). Every input is zod-validated; user-input problems throw `CoreInputError` (`invalid-input` | `unknown-id`), and any other Error means a config/bundle bug. Results carry a `BasisItem[]` provenance trail (`basis.ts`). Formula files: `model-math.ts` (params, MoE, MLA, layer groups, embeddings), `timing.ts` (decode/prefill/TTFT roofline), `solve.ts` (legal TP shapes, min-GPU search, max concurrency), `concurrency.ts` (users → concurrent load funnel), `policy.ts`.
- **One formula, no copies**: the web site and the future MCP server must not implement formulas themselves; they call core. `data` reuses core's model-math for config validation (Ruling R31c).
- **`packages/web`**: static Vite + React 19 + antd 6 + D3 site. `src/bundle.ts` is the only place `bundle.json` is imported and `src/accuracy.ts` the only place `accuracy.json` is. `state/` is one central reducer store synced to the URL (`state/url.ts`); `compute/` turns state into a view by calling core (only `CoreInputError` becomes an error view; workbench data is computed only for the open row); `i18n/` has `en` and `zh-TW` with the language held in the store; `motion.ts` respects `prefers-reduced-motion`; `test/setup.ts` provides media-query mocks (dark, reduced motion, hover-none).

## Rules the build and review enforce

- **Data integrity is the top-priority rule (spec §2.1).** Never invent a value. Anything inferred must be marked `estimate` (shown to users as 推估) with its rationale and evidence. A result is only as trustworthy as its weakest input, so results that use `estimate`/`unverified` inputs must be flagged. Research behind config values lives in `docs/research/*.md`, with sources.
- **Model policy (spec §2.2):** catalog models whose publisher (or `hfRepo` owner) is in `config/policy.yaml` `excludedCountries`/`excludedOrgs` fail the build. User-entered custom models are not origin-checked but always carry `CUSTOM_MODEL_WARNING`.
- **`config/models/*.yaml` is generated by `data:import`; do not hand-edit**. Re-import instead (`--revision <sha>` pins a commit). `config/models/README.md` documents parser defaults, native-quant handling, exit codes and unsupported MoE layouts.
- Allocation unit is individual GPUs (not nodes); a replica uses TP ∈ {1,2,4,8} within one node, and TP must be legal per vLLM's rule (`legalTpOptions`). Macs are counted in machines.
- Calibration points are tagged `fit` or `validate` and kept separate; tolerance is ±25% for decode tok/s and TTFT and ±10% for max concurrency.

## Goal for imported models (issue #17)

Any Hugging Face model a user imports must get numbers (memory, GPUs, speed): precise where the calculator models its architecture, a conservative estimate otherwise. Trust order of a value:

**real benchmark > precise compute > estimate (推估) >>> error**

- **Real benchmark**: measured on hardware (calibration points); catalog models in the suggest list are benchmarked by the team.
- **Precise compute**: the architecture is modelled and every formula is sourced (vLLM source at a pinned tag, the model's official code, or the paper), recorded in `docs/research/*.md` and as a spec Ruling. Every trending architecture (the targets in `packages/data/test/fixtures/hf/`) must reach this tier.
- **Estimate**: an architecture not modelled yet is computed from the standard config fields (hidden size, layers, heads, KV heads, head dim, vocab, MoE keys, checkpoint file sizes), always on the conservative side (more memory, slower). Values are `estimate` with basis and evidence (spec §2.1). The result tells the user plainly that the model's config is not standard and estimated values are used, lists the estimated parts, and offers a pre-filled request (GitHub issue form) to support the architecture precisely. Once it is modelled, every later import of that kind of model gets precise numbers.
- **Error**: never an expected outcome. An import that fails is a bug to fix, not a case to document; tests never assert a refusal as correct. The error view keeps the report button so users can file the bug.
- Not every config in the world can be modelled precisely, but nearly every model can be estimated; precise support is added architecture by architecture, trending ones first.
- Test samples are trending repos snapshotted with `pnpm data:snapshot` (replayed by `test/hf-snapshots.test.ts`); each must import, with its key fields asserted and its tier (precise or estimate) checked.

## Design goals (website)

- The calculator must be able to answer **every question a real user brings**, not just "how many GPUs": forward (users → GPUs), reverse (my hardware → users, and speed at my user count), budget-limited (fewer cards than suggested: what do I get, what to relax) and well-funded (more cards: how much faster, when it stops helping, bigger models), trade-offs (precision, model size, context vs users, TP split), comparison, growth planning, custom hardware/model/workload/speed, trust (why, sources, verify command, accuracy) and output (citation, share). Do not assume users can reach the suggested amount. The question catalogue and personas are in `docs/research/user-questions.md` and `docs/research/usability-test-v4.md`.
- Answering more questions must not add clutter: one complete sentence as input (never "·" fields), one-line answer, one row per platform; everything else appears on demand. No separate "advanced mode" and no mode switch that everyone has to see.

## UI design rules (user-specified)

- **Think through user journeys before designing.** For every feature, write the moment a user needs it and put the entry exactly there. People who need it find it naturally; people who don't never notice it. Examples: "找不到你的硬體？新增硬體" sits after the last platform row; custom model sits in the model search's not-found state; workload/speed "自訂…" is the last option; reverse ("I already have N cards") is the count control on that platform's row, not a mode switch.
- **Design by frequency of use.** Rare, long content takes an extra step instead of being dumped into a hover box: full lists, sources, verify command and accuracy sit behind "查看全部 →" or an explicit button, in a Drawer. **Existing hover popovers stay hover-triggered** (also tap and keyboard focus) — do not convert them to click; keep their content short.
- **No switching to reach information.** Switching (tabs, segmented views) lowers UX; once something is expanded, show its content in one view ordered by importance (two columns on wide screens, stacked on narrow), never "expand, then pick a tab". Rare audit content goes behind a button into a Drawer instead of a tab. The only exception: plots that are genuinely rarely used (e.g. expert Pareto/Roofline) may sit behind a toggle.
- **Popovers stay small.** A popover shows at most a short excerpt (e.g. top 3 items, one line each, fixed max width) plus "查看全部 N 項 →"; the full content lives in one Drawer. Lists, tables and multi-field forms go in a Drawer (citation text in a Modal). Never let a text box break the view or overflow the page.
- **Use the component library.** antd for every UI element (expand/collapse = antd `Collapse`, not hand-rolled toggles); icons only from `@ant-design/icons`, never emoji or symbol glyphs (⏳ → `HourglassOutlined`, ✗ → `CloseCircleOutlined`).
- **Motion on every UX change.** Every appearance, disappearance, state or value change transitions; nothing pops. One motion token (400 ms, ease-out cubic) shared by antd (ConfigProvider token) and D3. Changes caused by one input start and end together (no stagger); numbers tween; causal links are visible (more users → more machines → fuller bars). `prefers-reduced-motion` → 0 ms. Verify motion in a real browser (video or frames), not jsdom.
- **Visual spec is the approved prototype** (`docs/prototypes/calculator-demo-v7.html`, superseded by the latest approved demo). GPU platforms: one icon per node (blue `colorPrimary`, partial fill below one node); Mac / DGX Spark: one wide grey block per machine (`colorTextTertiary`). When icons don't fit, show `▢▢▢▢ … ▢▢▢▢` with a brace underneath labelled `× 80`, never overflow. Nothing on any row may overflow at 390/768/1024/1440 px.
- Dark mode follows `prefers-color-scheme`; phones (390 px) work with tap, no horizontal scroll.

## Demo / prototype rules

- A demo is a **single self-contained HTML file in `docs/prototypes/`** (e.g. `calculator-demo-v8.html`), CDN libraries only, like v7. It shows UI and interaction with mock data; no real calculation, no build step, no tests, no new packages, no changes to `packages/`.
- Build it fast: the point of a demo is quick feedback. Write it directly; do not spin up long agent runs, helper scripts or new branches for it. Demo work happens on the current website branch.
- Mock numbers must change plausibly and monotonically with inputs so causal animations are visible; label the page as a demo.
- After the user approves a demo, update the design doc, then plan and implement in `packages/web`.

## Design docs

- `docs/superpowers/specs/2026-10-19-inference-calculator-design.md`: the main spec (computation model §5, config §7, web §8, MCP §9). Numbered "Ruling R##" decisions referenced in code comments are recorded there.
- `docs/superpowers/specs/2026-10-21-direct-manipulation-design.md`: the binding design of the website v8 (implemented): direct manipulation, workbench, custom inputs, motion; visual spec `docs/prototypes/calculator-demo-v8.html`. §11 lists the rulings taken while implementing v8 (web W1–W11, core R1–R7).
- `docs/prototypes/calculator-demo-v8-requirements.md` (local file, not committed; may be absent): history — the user feedback after phase 2 that demo v8 answered; the design doc above supersedes it.
- `docs/superpowers/plans/`: implementation plans per phase.
- `reference/` (lecture slides) is gitignored and not needed.
- The spec's §10 layout says `apps/web`, but the site actually lives in `packages/web`.
