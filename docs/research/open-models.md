# 開源模型查證（截至 2026-10-19）

> 本文件是模型目錄與預設建議的查證依據。

- **方法**：
  - 逐一檢查 Hugging Face 組織頁、`config.json` 與 model card，並對照官方公告。
  - 無法從一手來源確認的內容，標為 **UNVERIFIED**。
  - 分數若未另外註明，都是開發者自行公布的數字。

## 0. 2026 年中以後的重要變化

- **Meta 改推「Muse」系列**：`meta-models/Muse-Glimmer-30B`（2026-08，Apache-2.0）、`Muse-Spark-Open-816B-A42B`（2026-10-15，gated）。HF 上沒有 Llama 5。
- **Thinking Machines Lab（美）**：`thinkingmachines/Inkling`（975B-A41B）、`Inkling-Small`（276B-A12B），2026-07 發布，Apache-2.0。
- **NVIDIA**：
  - 2026-10-15：Nemotron 3.5 Super-VL 120B-A12B、Bolt 74B-A9B
  - 2026-06-04：Nemotron 3 Ultra 550B-A55B
- **Mistral**：Medium 3.5 128B dense（2026-04）、Small 4 119B-A6B（2603）、Large 3 675B（2512）、Devstral 2 123B（2512）。
- **Google Gemma 4**：2026-03-31 / 04-02 發布；06-03 加入 12B（[release log](https://ai.google.dev/gemma/docs/releases?hl=en)）。
- **其他新模型**：IBM Granite 4.2（2026-08-25）、LG K-EXAONE 2.0 750B（Apache-2.0）、Cohere North-Mini-Code-1.0。
- **OpenAI**：gpt-oss-120b / 20b（2025-08）之後沒有新的基礎模型。

## 1. 基底模型的來歷

基底模型記為 `baseModel`（來歷紀錄，只供參考）。

## 2. 模型清單

代號說明：L = 層數；Q/KV = 注意力頭數 / KV 頭數；hd = head_dim；SWA = sliding window attention。

| HF repo | 開發者（國家） | 基底 | 日期 | 總參數 / 啟用參數 | KV 相關架構 | ctx | 授權 |
|---|---|---|---|---|---|---|---|
| [openai/gpt-oss-120b](https://huggingface.co/openai/gpt-oss-120b) | OpenAI (US) | 自行訓練 | 2025-08 | 117B / 5.1B | L36（18 full + 18 SWA-128），Q64/KV8，hd64，128 專家取 4 | 131072 | Apache-2.0 |
| [openai/gpt-oss-20b](https://huggingface.co/openai/gpt-oss-20b) | OpenAI (US) | 自行訓練 | 2025-08 | 21B / 3.6B | L24（12/12 SWA-128），Q64/KV8，hd64，32 專家取 4 | 131072 | Apache-2.0 |
| [google/gemma-4-31B-it](https://huggingface.co/google/gemma-4-31B-it) | Google (US) | 自行訓練 | 2026-03-31 | 30.7B dense | L60：50 SWA-1024（KV16，hd256）+ 10 global（KV4，hd512，k=v） | 262144 | Apache-2.0 |
| [google/gemma-4-26B-A4B-it](https://huggingface.co/google/gemma-4-26B-A4B-it) | Google | 自行訓練 | 2026-03-31 | 25.2B / 3.8B | L30：25 SWA（KV8，hd256）+ 5 global（KV2，hd512，k=v），128 專家取 8 | 262144 | Apache-2.0 |
| [google/gemma-4-12B-it](https://huggingface.co/google/gemma-4-12B-it) | Google | 自行訓練 | 2026-06-03 | 11.95B dense | L48：40 SWA（KV8，hd256）+ 8 global（KV1，hd512，k=v） | 262144 | Apache-2.0 |
| [meta-models/Muse-Glimmer-30B](https://huggingface.co/meta-models/Muse-Glimmer-30B) | Meta (US) | 由 Muse Spark 蒸餾 | 2026-08 | 約 29.6B dense | L52：39 SWA-2048 + 13 full，Q32/KV2，hd128 | 131072 | Apache-2.0 |
| [meta-models/Muse-Spark-Open-816B-A42B](https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B) | Meta (US) | 未說明 | 2026-10-15 | 816B / 42B | 依 card（config 為 gated）：L62，Q128/KV16，hd64，256 專家取 8 | 1M | Muse 授權（年營收超過 2,000 萬美元的 MaaS 條款），gated |
| [thinkingmachines/Inkling-Small](https://huggingface.co/thinkingmachines/Inkling-Small) | Thinking Machines (US) | 未說明 | 2026-07 | 276B / 12B | L42：35 SWA-512 + 7 global，Q32/KV8，hd128，256 專家取 6 + 2 共享 | 1048576 | Apache-2.0 |
| [thinkingmachines/Inkling](https://huggingface.co/thinkingmachines/Inkling) | Thinking Machines (US) | 未說明 | 2026-07 | 975B / 41B | L66：55 SWA-512（KV16）+ 11 global（KV8），Q64，hd128 | 1048576 | Apache-2.0 |
| [mistralai/Mistral-Medium-3.5-128B](https://huggingface.co/mistralai/Mistral-Medium-3.5-128B) | Mistral (FR) | 自行訓練 | 2026-04 | 128B dense | L88，Q96/KV8，hd128，無 SWA | 262144 | Modified MIT（大型營收例外） |
| [mistralai/Mistral-Small-4-119B-2603](https://huggingface.co/mistralai/Mistral-Small-4-119B-2603) | Mistral (FR) | 自行訓練 | 2026-03 | 119B / 6.5B | L36，MLA kv_lora 256 + rope 64，128 專家取 4 + 1 共享 | 1048576 | Apache-2.0 |
| [mistralai/Mistral-Large-3-675B-Instruct-2512](https://huggingface.co/mistralai/Mistral-Large-3-675B-Instruct-2512) | Mistral (FR) | 自行訓練 | 2025-12 | 675B | L61，MLA kv_lora 512 + rope 64 | 294912 | Apache-2.0（UNVERIFIED） |
| [mistralai/Devstral-2-123B-Instruct-2512](https://huggingface.co/mistralai/Devstral-2-123B-Instruct-2512) | Mistral | 自行訓練 | 2025-12 | 123B dense | 同 Medium 3.5 | 262144 | — |
| [nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16) | NVIDIA (US) | Nemotron 3 Super Base | 2026-10-15 | 120B / 12B | L88 = 40 Mamba2 + 40 MoE + **8 層注意力**（Q32/KV2，hd128），512 專家取 22 | 1048576 | OpenMDW-1.1 |
| [nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16) | NVIDIA | 自行訓練 | 2026-06-04 | 550B / 55B | L108 = 48 Mamba + 48 MoE + **12 層注意力**（Q64/KV2，hd128） | 262144 | OpenMDW-1.1 |
| [nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16) | NVIDIA | Nemotron 系列 | 2026-08 | 30B / 3B | L52（6 層注意力，KV2），128 專家取 6 | 262144 | — |
| [ibm-granite/granite-4.2-30b](https://huggingface.co/ibm-granite/granite-4.2-30b) | IBM (US) | granite-4.1-30b-base | 2026-08-25 | 30B dense | L64，Q32/KV8，hd128 | 131072 | Apache-2.0；支援語言含中文 |
| [allenai/Olmo-3.1-32B-Think](https://huggingface.co/allenai/Olmo-3.1-32B-Think) | AI2 (US) | 自行訓練 | 2026 | 32B dense | L64：48 SWA-4096 + 16 full，Q40/KV8 | 65536 | Apache-2.0；僅英文 |
| [CohereLabs/North-Mini-Code-1.0](https://huggingface.co/CohereLabs/North-Mini-Code-1.0) | Cohere (CA) | — | 2026-06 | 30.5B MoE | L49：36 SWA-4096 + 13 full，Q32/KV4 | 500000 | Apache-2.0 |
| [LGAI-EXAONE/K-EXAONE-2.0-750B-A37B](https://huggingface.co/LGAI-EXAONE/K-EXAONE-2.0-750B-A37B) | LG (KR) | K-EXAONE upcycle | 2026-08 | 750B / 37B | L78：20 full + 58 SWA，Q64/KV8，hd128 | 262144 | Apache-2.0；**不支援中文** |
| [taide/Gemma-3-TAIDE-12b-Chat-2602](https://huggingface.co/taide/Gemma-3-TAIDE-12b-Chat-2602) | TAIDE / 國科會 (TW) | google/gemma-3-12b-pt + 22B 繁中 token | 2026-02 | 12.4B | Gemma-3-12B 架構（config 為 gated；L48，Q16/KV8，hd256，5:1 SWA-1024，UNVERIFIED） | 128K | TAIDE-Gemma 授權，gated |

- 2026-10-19 以 `pnpm data:import` 核對 config：Gemma 4 12B / 26B-A4B 的 `attention_k_eq_v` 也是 `true`（原表只在 31B 註明 k=v），已補上。
- 上表的總參數是開發者公布的數字。`config/models/*.yaml` 的 `totalParamsB` 改取 safetensors `total`，多模態 checkpoint 會包含視覺／音訊編碼器與 MTP 層，所以會有差異：Gemma 4 31B 31.27B、26B-A4B 25.81B、Nemotron 3.5 Super-VL 124.45B、Nemotron 3 Ultra 560.52B、Inkling-Small 265.96B（表上 276B）、Inkling 952.38B（表上 975B）。

## 3. 主要評測（開發者自報，除非另註）

| 模型 | 繁中 / 多語 | 長上下文 | 程式 | Agent | 科學 |
|---|---|---|---|---|---|
| Gemma-3-TAIDE-12b-2602 | **TMMLU+ 58.02**（Gemma-3-12b-it 為 53.82） | — | — | — | — |
| Gemma 4 31B / 26B-A4B / 12B | MMMLU 88.4 / 86.3 / 83.4；26B-A4B 的 TMMLU+ 46.30（第三方部落格，UNVERIFIED） | MRCR-128K 66.4 / 44.1 / 43.4 | LCB v6 80.0 / 77.1 / 72.0 | tau2 76.9 / 68.2 / 69.0 | GPQA 84.3 / 82.3 / 78.8 |
| gpt-oss-120b | TMMLU+ 69.14（UNVERIFIED） | — | SWE-V 62.4 | — | GPQA 80.81 |
| Muse-Glimmer-30B | 未公布 | **AA-LCR 80.0** | SWE-V 76.0 | TB2.1 51.7 | GPQA 83.5，SciCode 43.6 |
| Granite 4.2 30B | MMLU-ProX-lite 66.64 | **RULER 128K 81.38** | SWE-V 57 | **BFCL v4 61.39** | GPQA 66.41 |
| Mistral Medium 3.5 | 24 種語言，含中文 | — | **SWE-V 77.6** | τ³-Telecom 91.4 | — |
| Inkling-Small | Global-MMLU-Lite 86.7 | — | **SWE-V 80.2**（自家 harness） | **TB2.1 64.7** | GPQA 89.5，SciCode 48.7 |
| Inkling | Global-MMLU-Lite 88.7 | — | SWE-V 77.6 | TB2.1 63.8 | GPQA 87.2 |
| Muse-Spark-Open | 100+ 種語言（無中文分數） | — | DeepSWE 60 | **TB2.1 76.4** | GPQA 89.0，**HLE+tools 61.0，SciCode 58.5** |
| Nemotron 3.5 Super-VL | WMT24++ 84.80 | AA-LCR 68.62 | SWE-V 71.10 | TB2.1 60.67 | GPQA 89.52 |
| Nemotron 3 Ultra | 語言清單含中文 | **RULER 1M 94.7** | SWE-V 70.7 | TB2.1 56.4 | GPQA 87.0 |

## 4. 能力等級建議（只用第 2 節的模型）

| 等級 | 參考模型 | 依據 | 誠實的缺口 |
|---|---|---|---|
| **T1 小型繁中對話** | Gemma-3-TAIDE-12b-Chat-2602；Gemma-4-12B-it / 31B-it；gpt-oss-20b | TAIDE（國科會），TMMLU+ 58.02，比它的基底高約 4 分；Gemma 4 多語能力強；gpt-oss-20b 成本低 | **繁中評測資料少**：唯一找到的第三方分數（UNVERIFIED）是 Gemma-4-26B-A4B 的 TMMLU+ 46.30。TAIDE 仍停留在 Gemma 3（[Taipei Times](https://www.taipeitimes.com/News/feat/archives/2026/09/24/2003864793)）。**國網應自行實測 TMMLU+ 與 TMLU。** |
| **T2 中型 RAG / 長文件** | Muse-Glimmer-30B；Granite-4.2-30B；Gemma-4-31B-it（另可選 Mistral Small 4） | 約 30B 等級中長上下文分數最好；三者皆為 Apache-2.0，而且 KV cache 小 | 沒有繁中長文件評測；Granite 明列支援中文，另外兩個沒有 |
| **T3 程式 / Agent** | Inkling-Small；Mistral Medium 3.5；Nemotron 3.5 Super-VL；預算有限時用 Muse-Glimmer-30B | Inkling-Small SWE-V 80.2、TB2.1 64.7；Medium 3.5 SWE-V 77.6；Nemotron 只有 8 層注意力，KV 很省 | 沒有繁中程式評測 |
| **T4 前沿科學 Agent** | Muse-Spark-Open-816B-A42B；Inkling；Nemotron 3 Ultra；較便宜的選擇是 Inkling-Small | Muse-Spark-Open 的 Agent 與科學分數在第 2 節的模型中最好 | **生資 Agent 缺口**：第 2 節的開源模型都沒有公布 BixBench、LAB-Bench 或 BiomniBench 分數。Muse-Spark-Open 對 SecureBio BioTIER 的拒答率超過 98%，可能妨礙正當的生醫用途，**部署前必須實測**；它的 MaaS 條款也需要法務審閱 |

## 5. 授權

- Mistral Medium 3.5：Modified MIT
- TAIDE：自訂授權
- Nemotron：OpenMDW / NVIDIA Open Model License
- Muse-Spark-Open：Muse 授權（MaaS 條款）
