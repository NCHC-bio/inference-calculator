# 模型目錄（config/models）

每個 `<id>.yaml` 都由 `pnpm data:import` 從 Hugging Face 產生，**不要手改**；要更新就重新匯入。

- `id` = repo 名稱（owner 之後的部分）轉小寫，檔名必須等於 `id`。
- `source` = `hf:<repo>@<commit 前 7 碼>`；匯入時會自動在 `config/sources.yaml` 新增（或取代同 repo 舊 commit 的）條目。
- `config.json` 一律讀取 API 回報的同一個 commit（`resolve/<sha>/config.json`），數值與出處對得上。
- `totalParamsB` 取 safetensors 的 `total`（多模態 checkpoint 會包含視覺／音訊編碼器與 MTP 層）。原生量化 checkpoint 的 `total` 仍是參數數，不是打包後的位元組數：gpt-oss-120b 的 `U8` 計數 114,661,785,600 = 128 專家 × 36 層 × 3 × 2880 × 2880，正好是專家參數數（2026-10-20 核對；HF 把每個打包的 MXFP4 位元組算成 2 個參數，scale 不計）。
- `nativeQuant`（2026-10-20 起）：config.json 有 `quantization_config`（頂層，或多模態的 `text_config`／`llm_config` 內）時寫入，表示這個 repo 的 checkpoint 本身已量化。
  - ModelOpt 0.29 以前的 checkpoint（例如 nvidia/Llama-3.3-70B-Instruct-FP8）的量化設定不在 config.json，而在同目錄的 `hf_quant_config.json`（2026-10-20 起支援）：model API 的檔案清單有這個檔、config.json 又沒有 `quantization_config` 時，匯入工具讀取同一個 commit 的這個檔（與 vLLM v0.32.0 相同，`vllm-v032-hf-quant-config`）。只接受 `producer.name` = modelopt、`quantization.quant_algo` = FP8，而且 `exclude_modules` 含 `lm_head`（ModelOpt 會量化沒排除的 lm_head；輸入 embedding 一律不量化，計算機把兩者都算成 16-bit），寫成 `method: modelopt`、`quant: fp8`；其他情況列為 missing。在此之前這類 checkpoint 會被當成 BF16 匯入。
  - `method` = `quantization_config.quant_method` 原文；`quant` = 對應的量化 id（`hf-parse.ts` 的 `NATIVE_QUANT_IDS`：`mxfp4` → `mxfp4`、`fp8` → `fp8`）。其他 quant_method、缺 quant_method、或 `compression_config`（compressed-tensors）一律列為 missing（退出碼 2），不猜。
  - `checkpointWeightBytes` = 組成 checkpoint 的權重檔的實際位元組數：讀同一個 commit 的 `model.safetensors.index.json`，把 `weight_map` 列到的每個檔案的大小相加；檔案大小取自 `GET /api/models/<repo>/revision/<sha>?blobs=true` 的 `siblings[].lfs.size`（沒有 lfs 時用 `size`）。不在 index 裡的檔案（gpt-oss 的 `original/`、Mistral 的 `consolidated-*`）是同一份權重的另一種格式，不計。沒有 index 時取單一 `model.safetensors`。檔案大小含每個檔案開頭的 safetensors header（gpt-oss-120b 約 77 KB）。status `official`，source 為同一個 `hf:<repo>@<sha7>`。
  - 估算時，選的量化等於 `nativeQuant.quant` 時權重記憶體直接用 `checkpointWeightBytes`（含混合精度，例如 gpt-oss 的 attention 仍是 BF16）；MoE 每步權重讀取量拆成專家權重（專家參數 × 原生格式每參數位元組）與其餘的非專家權重（`checkpointWeightBytes` − 專家權重），basis 會列出 `nativeQuant.expertBytes`（2026-10-20 起，原本用平均值）。選其他量化時照常以「總參數 × 每參數位元組」估算，但結果標記 `requiresRequantizedCheckpoint`，沒有驗證指令（官方 checkpoint 不是那個格式）。
- `vocabSize` / `tieWordEmbeddings`（2026-10-20 起）：config.json 的 `vocab_size`（必填，缺少時列為 missing）與 `tie_word_embeddings`（選填；Mistral 3 的 text_config 沒寫，未寫時視為不共用，記憶體估較大）。用來把 embedding／lm_head 以 16-bit 計算（spec §5.1）。13 個模型已以 `--revision <原 commit>` 重新匯入，除這兩欄與 verified 日期外沒有變動。
- 隱含預設值一律明示（2026-10-20 起，審查 M5）：config.json 沒有 `num_key_value_heads` 時沿用 Hugging Face 慣例 `kvHeads = num_attention_heads`（multi-head attention），但匯入工具會印出 `note: …`，並寫進產生的 YAML 開頭（`# note: …`）。
- 其他隱含預設值（2026-10-21 起，最終審查 M21、M22；同樣印出 `note:` 並寫進 YAML 開頭）：
  - 沒有 `head_dim`：headDim = hidden_size ÷ num_attention_heads（除不盡時列為 missing）。
  - sliding／full 混合的模型沒有 `num_global_key_value_heads`／`global_head_dim`：full 層沿用模型的 `num_key_value_heads`／`head_dim`（Gemma 4 有寫，gpt-oss 沒寫）。
  - 沒有 `tie_word_embeddings`：transformers 的 `PretrainedConfig` 預設是共用，但各 text config 類別會覆寫（例如 `MistralConfig` 為 False，transformers v5.20.2 `configuration_mistral.py` L78），所以依序：(1) 讀同一個 commit 的 `model.safetensors.index.json`，有獨立的 `lm_head.weight` 就是不共用、沒有就是共用；(2) 沒有 index 時用已查證的類別預設（目前只有 `mistral`）；(3) 都沒有時視為不共用（多算一張 16-bit lm_head，記憶體估較大，保守）。Mistral Small 3.1 的 checkpoint 有 `language_model.lm_head.weight`，與類別預設一致（不共用），目錄的數值不變。
  - `sliding_window: 0` 視為沒有 sliding window（vLLM v0.32.0 `vllm/config/model.py` L802-L808 把 0 轉成 None）。
  - `use_sliding_window: false`：transformers 會把 window 設為 None（例如 v5.20.2 `configuration_qwen2.py` L84），vLLM 讀的是 config 的 `sliding_window`（`vllm/config/model.py` L1612-L1614），所以忽略 window、全部視為 full 層；同時有 `sliding_attention` 的 per-layer 型別時無法判斷，列為 missing（fail closed）。
- 匯入安全（2026-10-21 起，最終審查 M23、M24）：`config/models/<id>.yaml` 已存在且 `hfRepo` 不是這次的 repo 時（不同 repo 的 slug 相同），拒絕覆寫並以 exit 2 結束；讀 `model.safetensors.index.json` 遇到 401／403 時與 config.json 一樣以 exit 3（gated／權限）結束。
- 認得但尚未建模的結構一律拒絕（2026-10-22 起，issue #17）：config 裡出現下列任一種時不匯入，而不是當作不存在來估算（DeepSeek V4.1 曾因只讀到 `sliding_window: 128` 而「匯入成功」但 KV 算錯）。每一種只回報一次，附上層數或鍵名（例如 `layer_types "linear_attention" on 48 of 64 layers`），網站以使用者的語言列出結構名稱，並提供「回報這個模型」。分類與鍵名見 `hf-parse.ts` 的 `UNSUPPORTED_FEATURES`、`UNMODELLED_LAYER_TYPES`、`UNMODELLED_KEYS`：
  - 混合線性注意力：`layer_types` 的 `linear_attention`（Gated DeltaNet、KDA），或沒有 `layer_types` 但有 KDA 的鍵（`linear_attn_config`、`kda_lower_bound` 等，例如 Ling 的 `bailing_hybrid`）。
  - 短卷積層：`layer_types` 的 `conv`（LFM2）。
  - Dense 與 MoE 混合：`first_k_dense_replace` > 0、`num_dense_layers` > 0（LFM2，之前沒有檢查）、`mlp_layer_types` 含 `sparse`／`moe` 以外的型別、`moe_layer_freq` ≠ 1、`mlp_only_layers`、`decoder_sparse_step` > 1、per-layer block 清單中只有部分是 MoE。
  - 特殊 MoE 結構：`moe_latent_size`、非 gated 的專家激活函數（如 `relu2`）、`shared_expert_sink`，以及同時有 `expert_hidden_dim` 與 `moe_intermediate_size` 且數值不同（無法判斷專家寬度）。
  - 每個 block 各自設定：`block_configs`（Nemotron puzzle）。
  - 壓縮 KV 注意力：`compress_ratios`／`compress_rates`，`layer_types` 的 `compressed_sparse_attention`／`heavily_compressed_attention`（DeepSeek V4 式）。
  - 跨層共用 KV：`kv_source_layer_ids`、`num_kv_shared_layers` > 0。
  - 稀疏注意力索引器：`index_n_heads`、`index_topk`、`index_source_layer_ids`、`indexer_n_heads`、`indexer_budget`，`layer_types` 的 `deepseek_sparse_attention`（DSA 的 indexer 有自己的 per-token key cache；GLM-5.3 修好 Dense／MoE 混合後會以 MLA 匯入，但 KV 會低估，所以一併拒絕）。
  - 詞表以外的嵌入查找表：`engram_layer_ids`、`engram_num_embeddings`、`ngram_vocab_size_base`、非空的 `ple_layer_ids`（每步只讀查到的列，不能當成每步全讀的權重）。
  - 記憶層 `memt`、重複執行的層 `n_recurrent_loops`／`n_recurrent_layers` 與 `layer_types` 的 `mlp`（Dory）、巢狀設定 `backbone_configs`（MemT Nano）：屬於少見的自訂架構，維持拒絕，走「回報這個模型」。
  - 值為 null、false、0 或空清單的鍵視為不存在。
  - Hyper-connections（`hc_mult`／`hc_count` > 1）不拒絕：權重已含在 safetensors 的 total，也沒有 per-sequence cache，計算機估算的量都不受影響；匯入時印出 `note:`。
- GGUF repo（2026-10-22 起，issue #17）：model API 的檔案清單沒有 `config.json` 但有 `.gguf` 時，不再回報「找不到」，而是回報 GGUF 並列出 model card 的 `base_model`，請改匯入原始模型（退出碼 2）。網站提供「改匯入 <原始模型>」按鈕，並清空發表者與國家（GGUF 上傳者通常不是原始發表者，不沿用）。
- 目錄中既有模型的 YAML 開頭沒有重新產生：phi-4 的 head_dim、gpt-oss 的 full 層維度、Mistral Small 3.1 的 tie_word_embeddings 這三項新增的 note 在重新匯入時才會寫入；數值與現在的 YAML 相同。
- 發表者來源國在 `excludedCountries` 內的模型無法加入目錄。
  - `origin`（發表者）只能由維護者以 `--developer` / `--country` 提供，工具不會猜測；缺少時退出碼 2。
  - `baseModel`：model card 有 `base_model` 時自動寫入（多個 repo 以 `, ` 串接），並印出 `info: model card base_model: …`。card 沒有時，可以用 `--base` 補上；`--base` 與 card 不一致時拒絕匯入（退出碼 2），以免紀錄失真。
  - `baseOrigin` 選填，只有維護者以 `--base-developer` / `--base-country`（兩個一起）提供時才寫入，工具不會猜測。

## 用法

```bash
pnpm data:import <owner/repo> --developer <名稱> --country <ISO2> \
  [--base <owner/repo>] [--base-developer <名稱> --base-country <ISO2>] \
  [--token-env HF_TOKEN] [--revision <commit>]
```

| 退出碼 | 意義 |
|---|---|
| 0 | 已寫入 `config/models/<id>.yaml` 與 `sources.yaml` |
| 1 | 網路或其他錯誤 |
| 2 | 缺少參數或 config 欄位、config 用到尚未建模的結構（印出 `unsupported architecture: …`／`missing: …`，每項一次），或是 GGUF repo（改匯入 `base_model`）；不寫入任何檔案 |
| 3 | gated repo（HTTP 401/403），需要以 `--token-env` 指定含 HF token 的環境變數 |

匯入後執行 `pnpm data:build`；若發表者來源國在 `config/policy.yaml` 的 `excludedCountries` 內，或 `hfRepo` 擁有者在 `excludedOrgs` 內，建置會失敗。

## 已匯入（2026-10-19）

開發者與國家取自 `docs/research/open-models.md` 第 2 節與 plan Task 5；基底取自 model card 的 `base_model` 中繼資料或 card 內文。

| id | 開發者（國家） | 基底 | 備註 |
|---|---|---|---|
| gpt-oss-20b、gpt-oss-120b | OpenAI (US) | 自行訓練 | MXFP4 原生量化（`nativeQuant`，2026-10-20 重新匯入） |
| phi-4 | Microsoft (US) | 自行訓練 | |
| mistral-small-3.1-24b-instruct-2503 | Mistral AI (FR) | mistralai/Mistral-Small-3.1-24B-Base-2503 | |
| mistral-medium-3.5-128b | Mistral AI (FR) | 自行訓練 | FP8 checkpoint（`nativeQuant`，2026-10-20 重新匯入） |
| mistral-small-4-119b-2603 | Mistral AI (FR) | 自行訓練 | MLA；FP8 checkpoint（`nativeQuant`，2026-10-20 重新匯入） |
| olmo-2-0325-32b | Ai2 (US) | 自行訓練 | |
| granite-3.3-8b-instruct | IBM (US) | ibm-granite/granite-3.3-8b-base | |
| granite-4.2-30b | IBM (US) | ibm-granite/granite-4.1-30b-base | |
| gemma-4-12b-it、gemma-4-31b-it、gemma-4-26b-a4b-it | Google (US) | 對應的 google/gemma-4-* 預訓練版 | |
| muse-glimmer-30b | Meta (US) | 由 Muse Spark 蒸餾（card 未列 `base_model`） | |
| llama-3.3-70b-instruct-fp8 | NVIDIA (US) | meta-llama/Llama-3.3-70B-Instruct（card 的 `base_model`，只是來歷紀錄） | 2026-10-20 匯入（commit fde04ee）：ModelOpt FP8 checkpoint（`hf_quant_config.json`；lm_head、embedding 為 BF16），NVIDIA 校正點的 dense 對照組 |

## 待支援架構（2026-10-19 自目錄移除，Ruling R31）

以下 4 個模型曾經匯入，但它們的 MoE 結構不符合核心的專家參數公式「專家數 × 3 × hidden × 專家 FFN 寬度 × 層數」（spec §5.1）。用這個公式算出的專家參數比總參數還大，啟用參數變成負數，結果完全不可信，所以已從目錄移除（YAML 與 `sources.yaml` 的對應條目都已刪除）。匯入工具現在遇到這些設定會列為 missing、以退出碼 2 結束，不寫入任何檔案。要支援它們，必須先擴充 schema 與核心公式。

| 模型（HF repo @ commit） | 舊公式的專家參數 vs. 總參數 | 不支援的原因（config.json 欄位） |
|---|---|---|
| nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16 @ 1f8953f | 1488.2B vs. 124.5B | `moe_latent_size: 1024`（專家在較小的 latent 維度運算，不是 hidden）；`mlp_hidden_act: relu2`（非 gated，每個專家 2 個矩陣，不是 3 個）；`layers_block_type` 的 88 個區塊只有 40 個是 MoE（其餘是 mamba／attention），`layers` 是區塊數，不是 MoE 層數 |
| nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16 @ 77df655 | 6957.8B vs. 560.5B | 同上：`moe_latent_size: 2048`、`mlp_hidden_act: relu2`、108 個區塊只有 48 個是 MoE |
| thinkingmachines/Inkling-Small @ 8cc5877 | 270.6B vs. 266.0B | `dense_mlp_idx: 2`（dense MLP 層與 MoE 層混用，`dense_intermediate_size` 16384）；`shared_expert_sink: true`（config 沒有說明語意） |
| thinkingmachines/Inkling @ 828496e | 956.7B vs. 952.4B | 同上：`dense_mlp_idx: 2`（`dense_intermediate_size` 24576）、`shared_expert_sink: true` |

這 4 個模型日後擴充 schema 與核心公式後即可重新匯入。

只有共享專家（`n_shared_experts`）、且每一層都是 MoE（例如 mistral-small-4-119b-2603，`first_k_dense_replace: 0`）時可以匯入：共享專家一律啟用，算在「總參數 − 路由專家」的常駐部分，公式仍然正確。

## 待匯入（gated，需要維護者的 HF token）

以下 repo 的 `config.json` 回應 HTTP 401（2026-10-19），沒有 token 無法讀取，因此**沒有手填任何數值**。維護者先在 HF 網頁接受各 repo 的授權條款，再執行：

```bash
export HF_TOKEN=<你的 token>   # 不要提交到 repo
pnpm data:import meta-llama/Llama-3.1-8B --developer Meta --country US --token-env HF_TOKEN
pnpm data:import meta-llama/Llama-3.3-70B-Instruct --developer Meta --country US --token-env HF_TOKEN
pnpm data:import meta-llama/Llama-3.1-405B --developer Meta --country US --token-env HF_TOKEN
pnpm data:import meta-models/Muse-Spark-Open-816B-A42B --developer Meta --country US --token-env HF_TOKEN
pnpm data:import taide/Gemma-3-TAIDE-12b-Chat-2602 --developer "TAIDE / 國科會" --country TW \
  --base google/gemma-3-12b-pt --base-developer Google --base-country US --token-env HF_TOKEN
pnpm data:build
```

匯入前請再確認：

- **Muse-Spark-Open**：card 沒有說明基底（research §1b）；發表者是 Meta（US）。
- **TAIDE**：基底 `google/gemma-3-12b-pt` 出自 research §2 表格；card 有 `base_model` 時會自動記錄，`--base` 只在 card 沒寫時需要（與 card 不一致會被拒絕）。
- **Llama 3.3 70B Instruct**：card 的 `base_model` 會自動記錄，不必填 `--base`。

## 跳過的 repo

這一輪清單中，沒有 repo 因為欄位缺漏而被跳過；除了上面的 gated repo 以外，全部都已匯入。

## 解析器的已知簡化

- Inkling 的短卷積（`use_sconv`，kernel 4）每個序列有少量狀態，schema 沒有對應的層類型，因此**沒有計入**。量級約為「層數 × 4 × hidden × 2 bytes」，相對 KV cache 很小。
- Nemotron 的 MTP 層（`num_nextn_predict_layers`）只用於推測解碼，沒有計入 `layerGroups`。
- Mamba 層的狀態位元組數取自 `mamba_ssm_cache_dtype`（float32 → 4，bfloat16 / float16 → 2）；config 沒寫時預設 2 bytes（依模型權重的 bf16 預設），並印出 `note:`、寫進 YAML 開頭的 `# note:` 註解（2026-10-20 起，審查 M5），不認得的 dtype 會列為 missing。Nemotron 3.5 Super-VL 與 Nemotron 3 Ultra 都寫 `float32`，所以是 4。Mamba 的卷積狀態（`conv_kernel`）沒有計入。
- config 有非 null 的 `sliding_window`、但沒有逐層類型欄位時，視為所有層都是 sliding window（一個涵蓋全部層的 sliding 群組）；本目錄中沒有這種模型。
- Gemma 4 的 `num_kv_shared_layers > 0`（KV 跨層共用）尚未支援，遇到時會列為 missing；本目錄中的 Gemma 4 都是 0。
