# 任務 → LLM 負載輪廓與模型能力等級

- 查證日期：2026-10-19
- **用途**：建立「領域任務 → 負載輪廓 → 所需能力等級 → 參考開源模型」的對照表，給計算機的「任務翻譯層」使用。
- **標記方式**：每個數字都附來源網址。**DERIVED** 表示由已附來源的數字推算而得。**UNVERIFIED** 表示只有二手或彙整來源，或在原始來源中無法確認。
- **分數比較的限制**：
  - 2026 年 benchmark 改版頻繁，SWE-bench Verified / Pro、Terminal-Bench 2.0 / 2.1 的分數不能互相比較。
  - 模型卡上的分數都是廠商自行報告。

## 第一部分：負載輪廓

### 1A. Agent 型工作負載（實測）

| 來源 / 負載 | 每任務呼叫次數 | 每次 / 每任務 token | 輸入:輸出 | Prefix cache 命中率 | 來源 |
|---|---|---|---|---|---|
| **TraceLab**（真實 Claude Code 與 Codex 使用紀錄：4,265 個 session、43 位開發者、357,161 個 LLM 步驟） | 每個使用者請求約 8.8 次 LLM 呼叫；每個 session 由工具觸發的步驟平均 73.6、中位數 15、p90 135 | 每步 prefix 中位數 126K、p90 467K；新增內容中位數 857；輸出中位數 252。99.6% 的步驟 context 會成長，每步約多 1.7K | 約 294:1（DERIVED） | 整體 95.7%；人類停頓後的請求為 84.4% | [arXiv 2606.30560](https://arxiv.org/html/2606.30560v2) |
| TraceLab 時間分配 | session 時間中，人類思考佔 92.3%、LLM 生成佔 3.3%、工具執行佔 4.8% | 每次生成中位數 5.7 秒 | — | — | 同上 |
| **GitHub Copilot agent**（正式環境） | 每 session 呼叫次數中位數 15、平均 40.6、p90 約 100 | 每次 prompt 中位數 68K（其中 63K 命中快取），輸出中位數 247 | 中位數超過 275:1 | 每次中位數 98%；第 1 次約 45%，第 3 次之後 92–94%；閒置超過 10 分鐘後掉到 0–5% | [arXiv 2608.00101](https://arxiv.org/html/2608.00101v1) |
| **Agentic AI Workload Characteristics**（Claude Code harness，以 vLLM 服務 Qwen3.6-27B 與 Gemma4-31B） | 平均 12–62 輪；長尾可達 786 輪（小模型在非思考模式下反覆 Edit 失敗） | 每任務累積 context：SWE-Pro 69–80K、Terminal-Bench 約 64K、資料分析 37–60K | 原始比例 54–560 倍 | 84.6–99.5% | [arXiv 2605.26297](https://arxiv.org/html/2605.26297v1) |
| 同上，時間分配 | 有快取時，decode 佔 LLM 時間 91–98.6%，prefill 佔 1.4–9% | — | — | — | 同上 |
| **Manus** | 典型任務約 50 次工具呼叫 | — | 約 100:1 | 「KV-cache 命中率是最重要的單一指標」 | [Manus blog](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) |
| **Anthropic 多 Agent 研究系統** | 簡單任務 3–10 次工具呼叫；複雜任務超過 10 個 subagent | Agent 約為聊天的 4 倍 token；多 Agent 約 15 倍 | — | — | [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system) |
| **Claude Code 官方文件** | Agent teams 約為一般 session 的 7 倍 token | 企業平均每位開發者每個活躍日約 $13 | — | 範例顯示 91% 的輸入命中快取 | [docs](https://code.claude.com/docs/en/costs) |
| Claude Code 每人速率建議 | 每人 TPM / RPM 依團隊規模遞減：1–5 人 200–300K / 5–7；20–50 人 50–75K / 1.25–1.75；100–500 人 15–20K / 0.37–0.47；500 人以上 10–15K / 0.25–0.35 | — | — | — | 同上 |
| SWE-bench Verified，OpenHands | — | Agent 寫程式消耗的 token 是單輪推理的約 1,000–3,500 倍；同一任務不同次執行可差到 30 倍 | — | 以 cache read 為主 | [arXiv 2604.22750](https://arxiv.org/html/2604.22750v3) |
| Terminal-Bench / SWE-Bench Pro 評測預算 | — | 每任務 0.9M–7.3M / 0.47M–16M token | — | — | [arXiv 2606.17930](https://arxiv.org/html/2606.17930) |
| MLE-bench | 每場競賽 24 小時 | 每場競賽約 1.7M 輸入加 0.2M 輸出（DERIVED） | 約 8.5:1 | — | [arXiv 2410.07095](https://arxiv.org/html/2410.07095) |

### 1B. 科學 / 生物資訊 Agent（實測）

| 來源 | 步數 / 輪數 | Token / 成本 / 時間 | 來源 |
|---|---|---|---|
| **BixBench3**（研究規模的計算生物任務，20 題） | 每次嘗試平均 695 輪 | **每任務平均 1.02 億 token、6.8 小時、$43**；最高 10.7 億 token、24 小時、$525。快取命中率 96% | [arXiv 2608.25286](https://arxiv.org/html/2608.25286) |
| **BiomniBench**（32,014 個真實 Biomni 使用者查詢） | 輪數中位數 15–53（依模型與 harness 而異） | 每任務 $0.58–4.58，約 8 分鐘 | [bioRxiv](https://www.biorxiv.org/content/10.64898/2026.05.12.724604v1.full) |
| 同上：查詢類型分布 | 資料分析 63.3%、文獻研究 55.0%、實驗設計 26.2%、快速事實查詢 25.1%、論文撰寫 15.4%（可重複計數） | — | 同上 |
| Biomni（原始論文） | 每任務 6–24 步 | 未報告 | [bioRxiv](https://www.biorxiv.org/content/10.1101/2025.05.30.656746v1.full.pdf) |
| CellVoyager（scRNA-seq） | 每次分析上限 8 步 | 未報告 | [bioRxiv](https://www.biorxiv.org/content/10.1101/2025.06.03.657517v1.full) |

### 1C. 非 Agent 型基準

| 負載 | Prompt token | 輸出 token | 來源 |
|---|---|---|---|
| Azure 程式碼補全 | 中位數 1,500 | 中位數 13 | [Splitwise](https://arxiv.org/html/2311.18677) |
| Azure 對話 | 中位數 1,020 | 中位數 129 | 同上 |
| Mooncake 對話 | 平均 12,035 | 平均 343 | [Mooncake](https://github.com/kvcache-ai/Mooncake/blob/main/FAST25-release/README.md) |
| Mooncake 工具 / Agent | 平均 8,596 | 平均 182 | 同上 |
| LMSYS-Chat-1M（一般消費者聊天） | 每則 69.5 | 214.5 | [arXiv 2309.11998](https://arxiv.org/html/2309.11998) |
| NVIDIA NIM：翻譯 | 500–2,000 | 約與輸入相同 | [NIM docs](https://docs.nvidia.com/nim/benchmarking/llm/parameters.md) |
| NVIDIA NIM：生成 | 約 100 | 約 1,000 | 同上 |
| NVIDIA NIM：摘要 / 檢索 | 約 1,000 | 約 100 | 同上 |

### 給計算機的重點

- **Agent 的每一步**大約是：約 10 萬 token 以上的 prefix 已在快取中、新增約 1K token、輸出約 250 token。**沒有 prefix caching 的話，prefill 成本會爆炸**，所以快取命中率必須是模型的參數。
- **每任務 token 量級**：
  - 聊天：10²–10³
  - 寫程式 Agent：10⁵–10⁷
  - 研究規模的生資分析：約 10⁸
- **Agent 的時間大多花在人類思考**（92%），所以每個席位造成的同時負載很低，這和 Anthropic 的每人 TPM 表一致。但如果是無人值守的批次 Agent，就不適用這個推論。

### TraceLab 精確數字（added 2026-10-19, verified；[arXiv 2606.30560v2](https://arxiv.org/html/2606.30560v2)）

計算機「研究助理」負載使用的數字，原文出處如下：

| 數字 | 原文位置與內容 | 範圍 |
|---|---|---|
| 每步 prefix 中位數 **126,180** token | Table 8，Claude 那一列：「Claude 194,361 59,949 126,180 467,082 918,111」，126,180 位於 P50 欄。內文：「A median Claude step reads back 126k prefix tokens.」 | **只限 Claude**。Codex 為 115,584。導論另寫「about 119K prefix tokens」，論文沒有說明這個數字的範圍 |
| 每步輸出中位數 **252** token | Table 8，Claude 那一列：「Claude 690 132 252 1,671 6,571」，252 位於 P50 欄。內文：「a median of only 252 output tokens for Claude and 184 for Codex」 | **只限 Claude**。全體中位數為 214（§4.3） |
| 前綴快取命中率 **95.7%** | Table 11 的 Total 欄。導論：「The global prefix cache hit rate is 95.7%.」 | 全體 |
| LLM 生成佔工作階段時間 **3.3%** | Table 7：「LLM generation 16.1m 2.0m 26.7m 3.9h 3.3%」。§4.4：「surpassing LLM generation (3.3%)」 | 佔全部經過時間。若把人類停頓以 1 小時為上限，比例升到 14.5% |

## 第二部分：開源模型（2026 年 10 月）

### 2A. 規格與分數（以模型卡為準）

| 模型 | 總參數 / 啟用參數 | 原生 context | 授權 | 重點分數 | 來源 |
|---|---|---|---|---|---|
| Mistral Large 3 | 675B / 41B | 256K | Apache-2.0 | — | [Mistral](https://mistral.ai/news/mistral-3) |
| Llama 4 Maverick / Scout | 400B / 17B；109B / 17B | 1M；10M | Llama 4 Community | Maverick：GPQA 69.8（明顯落後 2026 年的模型） | [HF](https://huggingface.co/meta-llama/Llama-4-Maverick-17B-128E-Instruct) |
| Mistral Medium 3.5 | 128B dense | 256K | Modified MIT | SWE-V 77.6 | [HF](https://huggingface.co/mistralai/Mistral-Medium-3.5-128B) |
| Mistral Small 4 | 119B / 6.5B | 256K | Apache-2.0 | GPQA 71.2 | [HF](https://huggingface.co/mistralai/Mistral-Small-4-119B-2603) |
| gpt-oss-120b / 20b | 117B / 5.1B；21B / 3.6B | 131K（UNVERIFIED） | Apache-2.0 | 120b：GPQA 80.8 | [HF](https://huggingface.co/openai/gpt-oss-120b) |
| Gemma 4 31B | 30.7B dense | 256K | Apache-2.0 | GPQA 84.3；MMMLU 88.4 | [HF](https://huggingface.co/google/gemma-4-31B-it) |
| Gemma 4 26B-A4B | 25.2B / 3.8B | 256K | Apache-2.0 | — | 同上 |
| Biomni-R0-32B | 32B（Qwen3-32B 微調） | 32K（YaRN 可延伸到 131K） | MIT | Biomni-Eval1 約 0.67（UNVERIFIED） | [HF](https://huggingface.co/biomni/Biomni-R0-32B-Preview) |

### 2B. 繁體中文 / 台灣

| 模型 / 評測 | 重點 | 來源 |
|---|---|---|
| Gemma-3-TAIDE-12b-Chat-2602 | 以 Gemma-3-12B 為基礎，128K context。TMMLU+ 58.02（Gemma-3-12b-it 為 53.82）。**授權條款需確認** | [HF](https://huggingface.co/taide/Gemma-3-TAIDE-12b-Chat-2602) |
| Llama-Breeze2-8B | 以 Llama 3.2 為基礎，支援視覺與 function calling；模型卡上沒有分數 | [HF](https://huggingface.co/MediaTek-Research/Llama-Breeze2-8B-Instruct) |
| TW-LegalBench（台灣法律） | claude-sonnet-4.5 81.0、gpt-5 76.7、llama-taiwan-70b 63.4、gpt-oss-120b 56.0、breeze-7b 39.6 | [arXiv 2606.18699](https://arxiv.org/html/2606.18699v1) |
| 普遍現象 | 以簡體中文為主的模型，TMMLU+ 分數低於 CMMLU | [arXiv 2505.02177](https://arxiv.org/pdf/2505.02177) |
| **缺口** | 找不到 2026 年主力開源模型的 TMMLU+ 分數，**需要國網自行實測** | — |

### 2C. 科學 / 生物資訊 Agent 評測中的開源模型

| 評測 | 結果 | 來源 |
|---|---|---|
| BixBench（205 題） | GPT-5.4 79.02%。移除 skills 後 GPT-5.4 掉到 42.44%，**harness 的影響和模型一樣大** | [arXiv 2609.03871](https://arxiv.org/html/2609.03871v2) |
| LAB-Bench2 SeqQA2（有 harness / 只用基礎模型） | GPT-5.5 75.0 / 64.75 | 同上 |
| BiomniBench（滿分 100） | Opus 4.7 63.94、GPT-5.5 63.57 | [bioRxiv](https://www.biorxiv.org/content/10.64898/2026.05.12.724604v1.full) |
| BixBench3 | GPT 5.6 Sol 0.48、Opus 4.8 0.46 | [arXiv 2608.25286](https://arxiv.org/html/2608.25286) |
| BioAgent Bench | 作者結論：開源模型的主要瓶頸是 **Agent 能力**，不是生資知識 | [arXiv 2601.21800](https://arxiv.org/html/2601.21800v3) |

## 等級建議（依上述證據綜合，非單一來源）

目錄採用的能力等級參考模型以 `docs/research/open-models.md` 第 4 節為準。

| 任務類型 | 負載輪廓 | 證據支持的最低等級 | 參考開源模型 |
|---|---|---|---|
| (a) 繁中聊天 / 問答 | 約 10³ 輸入 / 10² 輸出，單次呼叫 | 小型 dense（約 12–30B），最好經過台灣在地化調校 | Gemma-3-TAIDE-12B、Gemma 4 12B / 31B、gpt-oss-20b |
| (b) 文件 RAG | 約 1–15K 輸入、100–350 輸出 | 中型模型，context ≥128K | Muse-Glimmer-30B、Granite-4.2-30B、Gemma 4 31B、gpt-oss-120b |
| (c) 程式協助 | 補全 1.5K / 13；對話式 1–2K / 約 1K | 27–35B 等級的 SWE-V 可達 73–77 | Muse-Glimmer-30B、Mistral Medium 3.5、Inkling-Small |
| (d) 多步驟 Agent 工具使用 | 每 session 15–100 次呼叫、每次 68–126K prefix、約 250 輸出、需要 prefix cache | 27–31B 在非思考模式下容易陷入無效迴圈，建議用思考模式，或 ≥200B 的 MoE | Inkling-Small、Mistral Medium 3.5、Nemotron 3.5 Super-VL |
| (e) 科學 / 生資 Agent | 15–700 輪；每任務 10⁶ 到 10⁸ token；持續數小時 | 前沿開源 MoE（≥1T 總參數，或 ≥30B 啟用參數） | Muse-Spark-Open、Inkling、Nemotron 3 Ultra；Biomni-R0-32B 可當作輕量的專用模型 |

**找不到的資料**：

- 開源模型的 BioML-bench 分數
- BurstGPT 的整體平均值
- 2026 年模型的 TMMLU+ 分數
