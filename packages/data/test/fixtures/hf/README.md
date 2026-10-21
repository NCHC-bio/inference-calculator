# HF config fixtures

Real `config.json` files downloaded from Hugging Face on 2026-10-19, unchanged except where noted below.
Hand-written fixtures do not name or copy any real model.

| file | origin |
|---|---|
| phi-4.json | microsoft/phi-4 @ 2db69c1c3e91a05d2c64a3185acfbaf36f744e25 |
| gpt-oss-120b.json | openai/gpt-oss-120b @ b5c939de8f754692c1647ca79fbf85e8c1e70f8a |
| gemma-4-31b-it.json | google/gemma-4-31B-it @ 842da3794eaa0b77d5f08bae87a17459d91ff475 |
| nemotron-3.5-super.json | nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16 @ 1f8953f7f0935358e3605150d22bc15df062061c. **Edited:** removed the unparsed key `image_tag_type`; otherwise verbatim upstream. |
| multimodal-text-config.json | mistralai/Mistral-Small-3.1-24B-Instruct-2503 @ 68faf511d618ef198fef186659617cfd2eb8e33a |
| inkling-small.json | thinkingmachines/Inkling-Small @ 8cc5877b44d343f88b92086aa1fb72897950f06a |
| mistral-small-4-119b-2603.json | mistralai/Mistral-Small-4-119B-2603 @ a11f36bebf709121056b1dbcc943d1c6afbe494d (downloaded 2026-10-20) |
| gpt-oss-120b.revision.json, mistral-small-4-119b-2603.revision.json | `GET /api/models/<repo>/revision/<sha>?blobs=true` at the same commits (downloaded 2026-10-20). **Edited:** only `id`, `sha` and `siblings` kept; each sibling keeps `rfilename`, `size` and `lfs.size` (the fields the importer reads). File sizes are verbatim. |
| gpt-oss-120b.index.json, mistral-small-4-119b-2603.index.json | `model.safetensors.index.json` at the same commits (downloaded 2026-10-20). **Edited:** `weight_map` keeps one tensor per file (the importer only reads the set of file names); `metadata` is verbatim. |
| llama-3.3-70b-instruct-fp8.json, llama-3.3-70b-instruct-fp8.hf_quant_config.json | nvidia/Llama-3.3-70B-Instruct-FP8 @ fde04ee76a27704c88f569542ef023b57d4d0362 `config.json` and the ModelOpt `hf_quant_config.json` (downloaded 2026-10-20), verbatim |
| llama-3.3-70b-instruct-fp8.revision.json, llama-3.3-70b-instruct-fp8.index.json | revision API (blobs=true) and `model.safetensors.index.json` at the same commit (downloaded 2026-10-20), edited as the gpt-oss / Mistral ones above |
| mla-synthetic.json | hand-written synthetic MLA config |
| snapshots/*.json.gz | Issue #17 import-coverage targets, written by `pnpm data:snapshot <owner/repo>...` on 2026-10-22 (see below) |
| missing-fields.json | hand-written synthetic config without `num_hidden_layers` |

## Import-coverage snapshots (issue #17)

`snapshots/<owner>__<name>.json.gz` holds every Hugging Face response `fetchHfModel` can request for one repo at one
commit, replayed by `test/hf-snapshots.test.ts` (a URL not in the snapshot throws). Gzip because ModelOpt mixed-precision
configs list every quantized layer (the Nemotron 3.5 Bolt and Super NVFP4 `config.json` / `hf_quant_config.json` run
to 4–6.5 MB). Responses are verbatim except: the model API keeps `id`, `sha`, `safetensors`, `pipeline_tag`, the
card's `license` / `license_name` / `base_model` / `base_model_relation` and sibling names; the revision API keeps
`id`, `sha` and each sibling's `rfilename` / `size` / `lfs.size`; the safetensors index keeps `metadata` and, in
`weight_map`, one tensor per file plus every `lm_head` tensor. Gated repos (401/403) are skipped.

`snapshots-local/` is gitignored: snapshots kept on a developer's machine only (`pnpm data:snapshot --local <owner/repo>...`),
with their expectations in `snapshots-local/cases.json` (same shape as `CASES` in the test). The test runs them when the
folder exists and skips them otherwise.

| repo | commit |
|---|---|
| LiquidAI/LFM2.5-24B-A2B | 3fcfdbfa1a1b6d8166846a6323e69f1e1254440d |
| nvidia/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB-GGUF | e0fecb69cb3e5e4c5e8a056fa2aec98c78e91246 |
| nvidia/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB | cf2effc5c4b794ee9fb8d34eab3d1d65ce64142f |
| nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16 | 1f8953f7f0935358e3605150d22bc15df062061c |
| nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4 | 59b8721646c38111a242da18218859fb2b454322 |
| nvidia/NVIDIA-Nemotron-Labs-Dory1.0-4B-BF16 | b366b87f762ea334ba3eb55912031baba1515810 |
| unsloth/LFM2.5-24B-A2B-GGUF | aacc77834f6aa568c93b4dbd6d295059736be98c |
