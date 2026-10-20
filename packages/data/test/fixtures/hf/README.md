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
| missing-fields.json | hand-written synthetic config without `num_hidden_layers` |
