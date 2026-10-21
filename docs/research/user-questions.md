# 真實使用者如何提問：LLM 推論部署規劃

- 查證日期：2026-10-19
- **涵蓋範圍**：Reddit 與 Stack Overflow 被爬蟲封鎖，無法取得。改用以下來源：Level1Techs、Hacker News、HF 論壇、discuss.vllm.ai、GitHub（vLLM / llama.cpp / Ollama / SGLang / Open WebUI）、NVIDIA 論壇、CSDN，以及機構論文與頁面。
- **中文來源的限制**：知乎無法抓取（403），PTT 搜不到結果。台灣來源只有機構新聞，沒有使用者問答串。
- **標記**：**[V]** 表示已實際開頁確認內容；**[U]** 表示只看過搜尋摘要，未開頁確認。

## A. 收集到的提問（41 則，節錄）

| # | 提問 | 誰在問 | 已知 → 想要 | 使用的單位 | 來源 |
|---|---|---|---|---|---|
| 1 | Local AI for apr. 200 users | 公司 IT | 150–200 人試辦 → 給主管的規劃 | 人、機器、EUR | [V](https://forum.level1techs.com/t/local-ai-for-apr-200-users/247618) |
| 2 | 約 200 名師生的本地 LLM | 私校網管 | 約 200 人，假設尖峰 20%（40 人），$8–10k → 硬體 | 人、同時人數、$ | [V](https://forum.level1techs.com/t/local-llm-for-around-200-users-academia/229639) |
| 3 | DGX Spark vs 2×R9700 vs Mac Studio M3 Ultra | 顧問 | 10–30 同時，**每人 20 tok/s** → 實測多人數據 | tok/s/人 | [V](https://forum.level1techs.com/t/sanity-check-on-my-math-dgx-spark-vs-2x-radeon-pro-r9700-vs-mac-studio-m3-ultra-for-multi-user-office-llm-serving-does-reality-match-the-numbers/253436) |
| 4 | 本地跑 DeepSeek-V3 670B | 大學生代教授問 | **尖峰約 100 同時**，$40–80K，128K context → 可行性 | 同時人數、$、context | [V](https://forum.level1techs.com/t/best-hardware-setup-to-run-deepseek-v3-670b-locally-on-40k-80k/233609) |
| 7 | 辦公室自架 LLM | 約 50 人公司 | 一張 5090 → **2 個同時、32k 就夠 50 人用**（4 人時每人 16k） | 人、同時、context | [V](https://news.ycombinator.com/item?id=44479025) |
| 8 | 部署給上百人 | 小公司 | 回覆者反問：要即時嗎？同時用嗎？能改成夜間批次嗎？ | 人、$/hr | [V](https://news.ycombinator.com/item?id=40881966) |
| 12 | sllm 共享 GPU | 使用者自己算 | 465 人 × 20 tok/s = 9,300 tok/s；單 node 尖峰約 3,000 → 約 150 同時 | tok/s/人 | [V](https://news.ycombinator.com/item?id=47639779) |
| 14 | 多人使用時效能劣化 | Flask 開發者 | 1 人 12 秒，10 人超過 3 分鐘 → 為什麼 | 人、秒 | [V](https://discuss.huggingface.co/t/deploying-llm-in-production-performance-degradation-with-multiple-users/50747) |
| 17 | 在某長度的 prompt 下能撐幾個同時使用者 | vLLM 使用者 | 2 GPU、Gemma-3-12B → 同時人數（**未解決**） | 同時人數 | [V](https://discuss.vllm.ai/t/how-to-benchmark-concurrency/1611) |
| 18 | How to size LLMs | — | context、batch → 要「確切的 GPU 數和 VRAM」 | GPU、VRAM | [V](https://discuss.vllm.ai/t/how-to-size-llms/1574) |
| 21 | max_num_seqs 有用嗎 | 700+ 使用者 | 約 128 同時處出現拐點 | 使用者 vs 同時請求 | [V](https://discuss.vllm.ai/t/question-about-max-num-seqs/3042) |
| 22 | 6 人各發 1 個請求和 1 人發 6 個請求一樣嗎 | — | **「使用者」與「sequence」的詞彙混淆** | — | [V](https://discuss.vllm.ai/t/to-understand-max-num-seqs-better/2609) |
| 25 | vLLM #29325：要求「memory planner API」 | — | **對計算機的直接需求** | — | [V](https://github.com/vllm-project/vllm/issues/29325) |
| 26 | Qwen3 235B-A22B 要幾張 GPU | — | — | GPU | [V](https://github.com/vllm-project/vllm/issues/17439) |
| 29 | llama.cpp 如何處理多人同時查詢 | — | `-np` slot 數，`-c` 會被平分給各 slot | — | [V](https://github.com/ggml-org/llama.cpp/discussions/24401) |
| 31 | Ollama MLX 引擎上的 NUM_PARALLEL | Apple Silicon 128GB 使用者 | 與 Mac Studio 規劃直接相關 | — | [V](https://github.com/ollama/ollama/issues/17280) |
| 33 | 4×H100 只 2 個並行就 OOM | — | 權重佔掉太多，KV cache 不夠 | — | [U](https://github.com/sgl-project/sglang/discussions/39791) |
| 34 | 2×H100×8 跑 R1 只有 325–600 tok/s（預期約 4000） | — | — | tok/s | [U](https://github.com/sgl-project/sglang/issues/5429) |
| 35 | Open WebUI 1000 人、200 req/s | 約千人組織 | 一張 A100 加 vLLM | 人、req/s | [V](https://github.com/open-webui/open-webui/discussions/7771) |
| 36 | **1200+ 同時活躍** 時劣化；約 5k 人、16 node | 大型部署 | 約 200 人一個 node 沒問題；**宣傳信寄出後 2 小時內新增 3000 人** | 人 | [V](https://github.com/open-webui/open-webui/issues/14945) |
| 38 | DGX Spark 多機分工 | 研究者 | NVIDIA 回覆反問：重延遲還是吞吐量？**多少同時使用者？** | — | [V](https://forums.developer.nvidia.com/t/deployment-models-and-multi-unit-workload-sharing-for-nvidia-dgx-spark-best-practices/360311) |
| 40 | vLLM 部署高並發 API | CSDN | Qwen2-72B AWQ、1×H100：並發 64、約 1100 tok/s、P99 TTFT 380ms | 並發、tok/s、P99 | [V](https://deepseek.csdn.net/6a74b13c10ee7a33f2976484.html) |
| 41 | 私有化部署硬體 | CSDN | 「核心看三個指標：模型大小、並發用戶數、響應延遲」；「總用戶 100 人但同時在線不超過 15 人，1 張卡就夠」 | 並發、延遲 | [V](https://aicoding.csdn.net/6a687486662f9a54cb952fd5.html) |

知乎（[U]，403）上看到的公式：「單卡最大並發 =（顯存 − 權重 − 框架開銷）÷ 單請求動態開銷」，以及「單請求與 500 並發所需的 GPU 數量差 20 倍以上」。

### 機構部署者如何描述容量

- **GWDG Chat AI**（德國 HPC 中心，Slurm 加 vLLM）[V](https://arxiv.org/abs/2407.00110)
  - 註冊使用者 9,000 多人，平日活躍 400–500 人（約 5%），週末使用量下降。
  - 100 多個 API 使用者讓請求量「劇增」。
  - 依「時間窗內的平均同時請求數」自動擴充。
- **U. Idaho MindRouter** [V](https://ai4ra.uidaho.edu/wp-content/uploads/2026/04/Sheneman_MindRouter_PEARC26_Short_Paper.pdf)
  - 13 node、40 GPU、64 個模型；17 天處理 873M token。
  - 用 token 數、kWh、相當於多少 API 費用來描述容量；用群組配額和 fair-share 分配資源。
- **HS Kaiserslautern** [V](https://ki.hs-kl.de/ai-infrastructure-at-a-modern-applied-university-a-look-behind-the-scenes)：12 張 A100，規模靠訪談 7 位教職員決定。
- **高科大 高科iAI** [U](https://www.1111.com.tw/news/166371/amp/)：全校共用 16 張 H200，每人有「AI 使用額度」。
- **台大** [U](https://www.ettoday.net/news/20260613/3182689.htm)：倡議「學生 AI 軟體與 Token 的近用平權」，以 token 描述。
- **國網 TAIWAN AI RAP** [V](https://rap.genai.nchc.org.tw/news/3)：資源「依實際使用數據」調整。
- **LLNL LLamaMe** [U](https://hpc.llnl.gov/sites/default/files/2025-10/LLamaMe-LC-user-meeting.pdf)：4×H100，每人每分鐘限 10 個請求。

## 1. 意圖分群（41 則，只計主要意圖）

| 排名 | 意圖 | 則數 |
|---|---|---|
| 1 | **同時處理是怎麼運作的、要調哪個參數？**（max-num-seqs、-np、NUM_PARALLEL、使用者 vs 請求） | 10 |
| 2 | **正向推算：N 個使用者加某個模型，需要什麼硬體、幾張 GPU、多少錢？** | 8 |
| 2 | **反向推算：我有硬體 X，能撐多少人？** | 8 |
| 4 | **為什麼變慢、負載一高就壞？**（TTFT 暴增、500 錯誤、OOM） | 5 |
| 5 | 平台選擇（Mac / Spark / RTX / DGX，買還是租） | 4 |
| 5 | 擴展架構（TP vs DP、負載平衡、多節點） | 4 |
| 7 | 模型 X 放得下嗎（只看 VRAM） | 2 |

- **偏差提醒**：開發者論壇會讓「要調哪個參數」這類問題被高估。如果抓得到 Reddit，「放不放得下」與「平台選擇」很可能會更多。
- **核心需求**：正向加反向推算共 16/41。使用者常在同一串裡混著問：先問能撐幾人，接著問該買什麼。

## 2. 使用者用語與工程術語對照

| 使用者說 | 實際意思 | 工程術語 | 計算機的轉換方式 |
|---|---|---|---|
| 使用者、學生、員工、人 | 註冊總人數 | — | 問總人數，再明確換算出同時人數（見第 3 節） |
| 同時在線、concurrent users | 開著對話視窗的人，或正在等回答的人 | in-flight sequences / max_num_seqs | 兩者分開顯示：「開著視窗」不等於「正在生成」。Open WebUI 的「1200 同時活躍」是 WebSocket 連線數，不是正在 decode 的 sequence |
| clients、requests/s | API 流量 | 到達率 λ | Little's law：同時數 = λ ×（TTFT + 輸出 token 數 × TPOT） |
| 速度、夠快、每人 20 tok/s | 串流輸出速度 | TPOT / ITL | 用「每人 tok/s」表示，並附上和閱讀速度的比較 |
| 回應時間、3–5 秒 | 等到開始出字，或等到全部完成 | TTFT、端到端延遲 | 預設以秒為單位的 TTFT 目標，並顯示 P95/P99 |
| context、長文件 | 每人可用的記憶體 | max_model_len、KV tokens | 顯示「人數 × context = KV 容量」的權衡（例如 4 人時每人 16k） |
| 幾張卡、幾台、$ | 採購 | TP/DP 副本數 | **最終輸出必須是 node / GPU / 成本**，不能只給記憶體 |
| token、額度、kWh、相當多少 API 費用 | 預算與治理 | tokens/day、配額 | 提供 tokens/day ↔ requests/day ↔ GPU 小時的換算 |
| 高並發（沒有給數字） | 模糊 | — | 一律用情境預設強制給出一個數字 |

## 3. 從總使用者數推估尖峰同時人數（已發表的比例）

| 比例 | 情境 | 來源 |
|---|---|---|
| **約 5%** 為每日活躍（9,000 人中 400–500 人） | 學術 HPC 聊天服務，只有平日使用 | GWDG [V] |
| 每位日活躍使用者每天約 7 則訊息（推算） | 同上 | 推算值 |
| **4%**（約 50 人共用 2 個同時生成） | 辦公室，Qwen3-32B | HN #7 [V] |
| **10–15%**（100 人中最多 15 人在線）；中小企業以 15–30 同時規劃 | 中國企業指南 | CSDN #41 [V] |
| 活躍：總數 = 1:10–1:20 | 廠商指南 | [U](https://rdp.in/gpu-mart/knowledge-base/how-many-gpus-do-you-need-for-a-100-user-private-chatgpt-on-prem/) |
| **20%**（200 人中 40 人） | 學校 IT 自己的假設 | L1T #2 [V] |
| 20% | 廠商範例 | Spheron [U] |
| 約 32% 超賣（465 人配 150 個 slot），後來降到 80 | 付費共享 GPU | HN #12 [V] |
| 尖峰為日活躍的 10%（一般網站，非 LLM 專屬） | 網站壓測 | [U](https://loadfocus.com/blog/2025/04/calculate-concurrent-users) |
| 最忙的一小時佔每日流量 10–20%，再套 Little's law | API 規劃工具 | [U](https://aischool.lillytechsystems.com/tools/rate-limit-planner.html) |
| 上線爆量：2 小時內新增 3,000 人 | 學校寄出公告信後 | Open WebUI #14945 [V] |
| API / Agent 使用者主導負載，Agent 的並發可達 10–1000 倍 | — | GWDG [V]；arXiv 2606.20577 [U] |

#### GWDG 數字的出處與推算（人數漏斗預設值用，`config/workloads.yaml` `funnel`）

論文：Chat AI: A Seamless Slurm-Native Solution for HPC-Based Services，<https://arxiv.org/abs/2407.00110>（HTML 版 <https://arxiv.org/html/2407.00110>），以下皆為 §6.4 User Adoption（2026-10-21 重新核對）。

| 用到的數字 | 原文 | 位置 |
|---|---|---|
| 註冊約 9,000 人 | "by June 2024 this number increased to 9 000"（前文："In the first three months, over 6 000 users were registered in the service"） | §6.4 |
| 平日活躍 400–500 人 | "On average, about 400 to 500 users actively use Chat AI on a typical work day" | §6.4 |
| 累計訊息逾 35 萬則 | "In total, Chat AI has received and responded to more than 350 000 messages as of 30.07.2024." | §6.4 |
| 服務起點 2024-02-22 | "Since its initial release on February 22nd, 2024 to users of Academic Cloud" | §6.4 |
| 資料區間 | 圖 5 標題："Total inference requests per day from February 22nd until July 30th 2024." | Figure 5 |

- 日活躍比例：400–500 ÷ 9,000 = 4.4–5.6%，取 5%（註冊數是 2024 年 6 月，活躍數是「平均」，時間點不完全相同）。
- 每位活躍者每日則數（**本專案推算，論文沒有報告**）：2024-02-22 至 2024-07-30 約 159–160 天（日曆計算）；假設只在平日使用而取約 113 個工作日（5/7，**此為假設**，論文沒有給工作日數）；350,000 ÷ 113 ÷ 450 ≈ 6.9，取整 7。限制：論文沒說「訊息」是否含 API 流量（API 使用者另計，見上）、活躍人數是平均值不是逐日值。因此 7 在設定檔標為 `estimate`。
- 尖峰一小時佔比不是 GWDG 的數字，來源是上表的 API 規劃工具（[U]，secondary）：表中寫 10–20%，本節結論寫 15–20%；取 20%（兩個區間的上限，偏保守）。該頁憑證過期，2026-10-21 無法重新開啟，數字沿用本檔記錄。

**結論**：「同時」其實有好幾層意思，從外到內依序是：註冊 → 每日活躍 → 在線 → 正在生成。

- 聊天服務的已發表比例落在總人數的 4%–20%。從「在線」縮到「正在生成」還會再小一截。
- 計算機應該把這做成一個**可調預設值的漏斗**：
  - 每日活躍約為註冊人數的 5–10%（學術機構）
  - 尖峰一小時約佔每日請求的 15–20%
  - 再用 Little's law，從每小時請求數 × 每個請求的持續時間算出同時數
- **API / Agent 使用者必須分開輸入**，因為他們不適用以「人」為單位的比例。

## 4. 什麼樣的答案讓提問者滿意

- **具體方案：一個數字、成本、分階段導入**。這是唯一明確得到感謝的回答：「每台 80–100 人 → 3 台，GPU 約 €25k、總計 €30–40k，先買 2 台」（#1：「You saved me from making a big mistake」）。提問者隨後自己做了一張表：GPU 數 → 同時 session 數 → 使用者數 → €。
- **工具給的單一數字**：vLLM 的「Maximum concurrency … X×」和 Colab 計算機的「max concurrent requests」。這類數字直接對應使用者自己的配置，所以被信任。
- **權衡清單**：例如「32k 時 2 人、16k 時 4 人、8k 時 8 人」（#7），短而且能直接照做。
- **先反問釐清**：要即時還是批次？重延遲還是吞吐量？同時多少人？（#8、#38）
- **不被接受的回答**：「自己跑 benchmark」。#17、#20 都卡在工具操作上，最後沒有解決。#3 想要 Mac 多人同時使用的實測數據，結果沒人提供。

**對設計的啟示**：

- 輸出內容：
  - 主數字加上區間（保守 / 預期）
  - 各硬體方案的比較表（H100 / H200 / GB200 / Mac Studio）
  - context ↔ 人數的權衡
  - 用白話列出的假設
- 附上驗證指令，例如 `vllm bench serve --max-concurrency N`。使用者既要數字，也要能自己驗證。

**目前找不到的資料**：

- Mac Studio 多人同時使用的實測數據
- 台灣問答串
- 國網、TAIDE、高科大、台大公開的同時人數
