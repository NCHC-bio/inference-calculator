# 國網推論算力計算機：設計文件

- 日期：2026-10-19
- 狀態：**定稿，待使用者審閱**
- 研究依據：`docs/research/` 下的 6 份筆記，本文以 [R-xxx] 引用：
  - [R-HW]：nvidia-nchc-hardware.md
  - [R-MAC]：apple-silicon.md
  - [R-PRIOR]：prior-art-calculators.md
  - [R-USER]：user-questions.md
  - [R-TASK]：task-workload-and-models.md
  - [R-LEC]：reference/EAI_lec4.pptx（Roofline、吞吐 / 延遲、頻寬、量化）
- **標記約定**：標「**（設計者判斷）**」的內容是撰寫者自行決定、使用者尚未確認的部分。

---

## 1. 目的與緣由

國網中心（NCHC）要一套**推論任務的算力需求參考標準**，回答一個問題：

> 這個推論工作負載，在國網的每一種機台上，各需要多少 node、多少張卡？
> 給定的機台規模，能承載多少使用者、速度多快？

這套工具的對象有三種：

- **申請者與研究團隊**：用來規劃資源申請。
- **國網內部**：用來比較機台與採購（包括未來的 Mac Studio / Mac mini 推論機）。
- **AI Agent**：透過 MCP 呼叫。

**為什麼需要自己做**（證據見 [R-PRIOR]、[R-USER]）：

1. 現有計算機大多只回答「模型放不放得下」。使用者普遍不信任它們（HN：「大概 10 個計算機，沒一個能用」）。常見錯誤包括：
   - 忽略 KV cache
   - 忽略同時人數
   - 把 prefill 與 decode 混為一談
   - 不支援 MoE / MLA
2. **沒有任何工具處理共享 HPC 叢集的情境**：節點形狀、排程分區、NVLink 網域、跨節點 InfiniBand。
3. 使用者講的是「人」與「任務」，例如「全校 2 萬人」「我要做 scRNA 分析」。工程上需要的卻是「同時進行的 sequence 數」「token 長度」。中間的翻譯沒有工具在做。

**成功的樣子**：

- 領域專家不懂 LLM 也能在幾分鐘內拿到可以寫進申請書的數字，而且看得懂為什麼。
- 國網同仁能稽核每一個數字的出處。
- 隨著實際使用數據累積，國網只要改設定檔就能讓結果越來越準。

## 2. 目標、非目標、反目標

**目標**

- G1：三種入口（任務 / 人 / 硬體）都能得到答案。核心是**正向**（負載 → 硬體）與**反向**（硬體 → 容量）兩個方向。依 [R-USER]，這兩類各佔 8/41 則提問，是最主要的需求。
- G2：使用比「權重 × 1.2」精細得多的公式，涵蓋：
  - 架構相關的 KV cache（GQA / MLA / sliding window / 線性注意力）
  - MoE 專家載入
  - prefill / decode 分開計算
  - prefix cache
  - 平行化通訊成本（NVLink / IB / TB5）
  - 服務目標（TTFT / 每人 tok/s）
- G3：每個硬體與經驗數字都帶出處標記。結果以**區間**呈現（保守 / 預期），不給假精確的單一數字。
- G4：所有會變動的資料**集中在設定檔**，不寫死在程式中；改設定檔即可同時更新網站與 MCP。
- G5：視覺化以「一目了然、好操作」為準，含轉換動畫，讓非專家理解量級。
- G6：介面支援繁體中文與英文。
- G7：MCP 介面讓使用者的 Agent 能做同樣的計算，並拿到結構化結果與計算依據。

**非目標**

- 不做訓練、微調的資源估算。
- 不做即時排程或佇列狀態：不連接 Slurm，不顯示目前有多少空閒 node。
- 不取代實測：計算機會附上驗證指令，引導使用者用 benchmark 確認。
- 不在網站上提供硬體規格、校正係數的編輯介面。這些由國網同仁編輯設定檔維護。
- 第一版不支援 AMD、Intel、昇騰等其他加速器，但資料結構要能擴充。
- 不做多模態（影像 / 語音）的負載模型，但資料結構預留欄位（**設計者判斷**）。

**反目標**（即使技術上能動，出現這些也算失敗）

- 只丟一個大數字，沒有區間、沒有假設、沒有出處。
- 要求使用者懂「concurrent sequences」「TPOT」這類術語才能操作。
- 介面一次把所有參數攤開，讓人不知從何下手。
- 資料過時或打錯字卻沒人發現：沒有格式檢查、沒有查證日期。
- 公式在 MoE、長上下文、多節點這些國網最常見的情境下明顯失準。

## 2.1 資料誠信規則（使用者指定，最高優先）

**整個網站與 MCP 的所有計算，都必須嚴格依據可查證的來源，不能編造。凡是推估出來的，都必須明白告知使用者。**

每一個進入計算或顯示給使用者的數值、建議或對應關係，都必須屬於以下其中一類，並帶有對應標記：

| 狀態 | 意義 | 要求 | 介面標示（範例） |
|---|---|---|---|
| `official` | 廠商或國網官方公布 | 附出處連結與查證日期 | 不加標記，可展開看出處 |
| `measured` | 公開的實測結果，例如論文、benchmark | 附出處，並記錄量測條件（引擎、模型、設定） | 「實測」 |
| `derived` | 由其他已附出處的數值，經明確公式計算而得 | 記錄公式與輸入值的出處 | 「推算」，展開可看算式 |
| `estimate` | 依證據綜合判斷的**參考值**，沒有單一來源可以直接支持。例如「這類負載一般會用 yy 模型」、情境的預設上下文長度、能力等級 | 必須寫明判斷依據，列出所引用的證據出處，並記錄由誰、在何時判斷（`judgedBy` 記錄由誰，選填；沒填時以引入該值的 commit 作者為準；`verified` 記錄何時） | **「推估（參考用）」**，必須醒目，不能只藏在提示框裡 |
| `unverified` | 只有二手來源，或來源之間互相矛盾 | 附所有找到的來源與矛盾說明 | 「未查證」，並在結果的假設清單中列出 |
| `user` | 使用者在進階模式中自訂的值，或手動輸入的模型參數 | 只存在該次計算與分享網址中，不寫入設定檔 | 「自訂」，答案句旁標示「含自訂輸入」 |

規則：

1. **沒有標記的數值不得進入設定檔。** CI 必須檢查每個數值欄位都有狀態與出處，缺一個就讓建置失敗。
2. **結果的可信度等於最弱的輸入。** 只要結果用到任何 `estimate` 或 `unverified` 的輸入，結果本身就要標示，並在答案句旁列出是哪些輸入。例如：「需要 2 台（推估：使用了參考用的上下文長度、未查證的 IB 延遲）」。
3. **建議類的句子一律加上「參考用」字樣。** 這包括參考模型、能力等級、任務預設、人數漏斗比例。範例：「scRNA 分析這類研究助理負載，一般會用 T4 等級模型，例如〔open-models.md 中 T4 的參考模型〕（參考用；依據：〔該表所列評測〕）」。實際模型名稱以查證結果為準（§2.2）。
4. **計算依據面板**必須能追溯到每個輸入的出處，並且只顯示真正用到的值。
5. **MCP 回應**的每個數值都附狀態與出處 id，讓 Agent 轉述時也能保留「推估」的告知。
6. **本次討論中由撰寫者提出、尚無來源的預設值**，例如早先提議的情境上下文長度（一般對話 1,000 / 400 等），**不得直接使用**。實作時必須改用 [R-TASK] 1C 的有出處數值（Azure、Mooncake、LMSYS、NVIDIA NIM 等），或明確標為 `estimate` 並寫出依據。

## 2.2 模型限制

國網中心明確禁止在計算機集群使用紅色供應鏈模型。

目錄與預設模型的發表者來源國不得在 `config/policy.yaml` 的 `excludedCountries` 內；使用者自訂模型一律顯示警告（§9）。

## 3. 使用者與他們的問題

依 [R-USER] 的 41 則真實提問與機構案例，整理如下。

| 入口 | 使用者心裡的問題 | 他們有的資訊 | 計算機要補的 |
|---|---|---|---|
| **任務** | 「我要用 AI 做 X（例如 scRNA 分析、文件摘要），要多少資源？」 | 領域任務 | 任務 → 能力等級 → 參考模型 → 負載輪廓 |
| **人** | 「全校 N 人 / 本計畫 M 位研究員要用，要多少資源？」 | 總人數、用途 | 人數漏斗 → 同時 sequence 數 |
| **硬體** | 「我有 2 個 H200 node / 4 台 Mac Studio，能做什麼、撐幾人？」 | 硬體配置 | 可容納的模型、人數、速度 |

三個入口匯流到同一個計算核心與同一套視覺化。使用者也可以在結果頁直接改動任一側，例如改節點數或改人數，即時看到另一側的變化。

另有兩類延伸問題，也要回答：

- **比較**：「同一任務哪個平台划算？」
- **解析**：「為什麼要這麼多？瓶頸在哪？」

## 4. 工作負載模型

### 4.1 工作負載類別

每個類別都有自己的負載輪廓參數，預設值放在設定檔，數值依據 [R-TASK]。

| 類別 | 例子 | 負載單位 | 關鍵參數 |
|---|---|---|---|
| 互動聊天 / 問答 | 校園 ChatGPT | 人 | 輸入 / 輸出長度、每人每日請求數 |
| 文件 RAG | 知識庫問答 | 人 | 檢索段數 × 段長、輸出長度 |
| 文件分析 / 摘要 | 報告、法規分析 | 人或批次 | 長輸入、中等輸出 |
| 程式協助 | 補全、對話式 | 人 | 補全為短輸出、高頻率 |
| **研究助理（互動式 Agent）** | scRNA 分析、資料分析、文獻回顧等「把 LLM 當助理」的工作 | 人（席位） | 每 session 呼叫次數、每步 prefix 長度（約 10⁵）、每步新增（約 10³）與輸出（約 250）、快取命中率（約 95%）、人類思考時間佔比（約 92%） |
| 批次 Agent / 批次處理 | 無人值守的長任務、整批文件翻譯 | 任務 / 天 | 每任務總 token（10⁶–10⁸）、截止時間 |
| API 使用者 | 程式化呼叫 | 請求率 | 每秒請求數、長度分佈 |

「研究助理」類別底下有**領域任務預設**，例如「scRNA-seq 分析」「文獻回顧」「統計資料分析」。每個預設包含：

- 一段白話描述
- 建議的**能力等級**
- **參考模型**
- 負載輪廓參數

這些預設值由國網依實際統計持續更新。

### 4.2 能力等級與參考模型

設定檔定義能力等級，例如 T1 小型繁中對話、T2 中型 RAG / 程式、T3 Agent 工具使用、T4 前沿科學 Agent。每個等級包含：

- 白話描述（適合什麼任務）
- 參考模型清單，以及每個模型的依據：評測名稱、分數、來源連結
- 證據不足時的警示，例如「繁中能力未經實測」

初始內容依 `docs/research/open-models.md` 第 4 節的等級建議表。這張表是依證據綜合判斷的結果，所以等級與參考模型一律標為 `estimate`，介面上顯示「推估（參考用）」並列出評測依據（第 2.1 節）。選了某個等級後，使用者可以改選清單中的其他模型，或從模型目錄任選。

### 4.3 從人數推估同時負載（漏斗）

依 [R-USER] 第 3 節，所有比例都放在設定檔、可在進階設定覆寫。

```
註冊 / 總使用者 N
  × 每日活躍比例 d          （學術預設約 5–10%，GWDG 實測約 5%）
  × 每位活躍者每日請求數 r   （GWDG 推算約 7；Agent 類另計）
  × 尖峰小時佔比 p           （約 15–20%）
  ÷ 3600                     → 尖峰到達率 λ（請求 / 秒）
同時進行數 C = λ × 平均單請求服務時間（TTFT + 輸出長度 × TPOT）   ← Little's law
```

- 互動式 Agent 類：同時進行數 = 同時在線席位 × LLM 忙碌時間佔比。佔比預設取自 TraceLab，人類思考佔 92%。
- 批次類：每日總 token ÷ 單位硬體吞吐量 → 所需 GPU 小時，或在截止時間內所需的 node 數。
- 介面上要同時顯示「在線人數」與「正在生成的請求數」，避免 [R-USER] 裡常見的詞彙混淆。

## 5. 計算模型

所有公式都在 `core` 套件實作為純函數。每一步回傳**數值、單位、所用的設定項與其出處**，供「計算依據」面板與 MCP 使用。

**理論依據**（使用者 2026-10-19 指示）：

- 講義中的公式已逐頁萃取到 `docs/research/lecture-formulas.md`，以 A1–E3 編號，例如：
  - B1 Roofline
  - A4 有效算力 = 峰值 × 利用率
  - B3 批次共用權重讀取
  - C2 只用 dense 峰值
  - D1 功耗以 TDP 為上限
- 本節的每條公式都必須能對應到一個 R-LEC 編號，或對應到本節另附的出處。
- 程式碼中每個公式函數的註解，必須寫出對應的編號，例如 `// [R-LEC B1]`。這些編號也會出現在網站與 MCP 的計算依據中。

### 5.1 記憶體

- **權重**
  - 公式：W = Σ_張量 參數量 × 有效位元數 / 8
  - 有效位元數依量化格式取自設定檔，例如 FP8 = 8；AWQ / GPTQ 的 group128 約 4.25；GGUF Q4_K_M 約 4.85 [R-PRIOR]。
  - 未量化的部分（embedding、norm 等）依模型設定分開計算。vLLM 的 FP8、AWQ、MXFP4 只量化 Linear 與 MoE 層，embedding 與 lm_head 維持 16-bit：參數量 = vocab_size × hidden ×（共用 1／不共用 2，config 未寫時視為不共用），以量化設定的 `embeddingBytesPerParam` 計算（2026-10-20 補充，審查）。
  - MoE 模型的全部專家都要放進記憶體。
  - 原生量化 checkpoint（2026-10-20 補充）：HF config.json 有 `quantization_config` 的模型（gpt-oss 的 MXFP4、Mistral Medium 3.5／Small 4 的 FP8）記錄 `nativeQuant`。選的量化等於原生格式時，W = checkpoint 權重檔的實際位元組數（`checkpointWeightBytes`，含未量化的層）；MoE 每步權重讀取量拆成兩部分：專家權重 = 專家參數 × 原生格式的每參數位元組，非專家權重 = W − 專家權重（例如 gpt-oss 的 BF16 attention），非專家每步全讀、專家依觸及比例讀取。（2026-10-20 更正，審查：原本用平均每參數位元組 W ÷ 總參數，會把 BF16 的非專家層當成 MXFP4，低併發時速度高估約 1.9 倍。）選其他格式時照常估算，但結果標記 `requiresRequantizedCheckpoint`，因為官方沒有那個格式的 checkpoint。API 的量化輸入可用 `'native'`：有 `nativeQuant` 時解析為原生格式，否則為 BF16（quantization.yaml 的 `nativeForUnquantized`）。
- **每 token 的 KV cache**：依架構型別計算。
  - 標準 / GQA：2 × L × n_kv_heads × head_dim × bytes_kv
  - MLA：L × (kv_lora_rank + qk_rope_head_dim) × bytes_kv
  - Sliding window 層：decode 每步**讀取**的上限為 window 長度。**配置**（容量）依推論引擎（2026-10-20 更正，審查 L9）：
    - vLLM（hybrid KV manager，GPU 預設開啟；2026-10-20 再更正，審查 L9 修正）：
      - 穩態：每個常駐序列每個 sliding 層 min(window, 上下文) 個 token。vLLM v0.32.0 在每個 chunk 配置前釋放 window 外的 block（`allocate_slots` → `remove_skipped_blocks`；`SlidingWindowManager.get_num_skipped_tokens` = 已處理 token − window + 1）。
      - 進行中的 chunk：每個副本扣一次 min(max_in_flight_tokens, 上下文) 個 token 的 sliding 層 KV（各 sliding 組加總、含 TP 複製；上下文 ≤ window 時為 0），不是每人扣。max_in_flight_tokens = max_concurrent_batches × max_num_batched_tokens，兩者取平台的 `vllmDefaults`（v0.32.0 預設：async scheduling 開啟、PP = 1 → 2 批；max_num_batched_tokens H100／H200 8192、GB200 16384）。
      - 啟動檢查：1 個序列以上限計（full 層 ceil(上下文 ÷ bs) 個 block + sliding 層 ceil(min(window − 1 + max_in_flight_tokens, 上下文) ÷ bs) + 1 個 block，bs = block_size）仍放不下時，vLLM 拒絕啟動，判為記憶體不足（'mem'）並說明原因。
      - 依據：`docs/research/vllm-tp-kv-precision.md` §3.3、§3.11、§3.12 與影響第 4 點。上限（`SlidingWindowSpec.max_admission_blocks_per_request`）只用於啟動檢查、「Maximum concurrency」日誌與 admission gate。block 取整見下方 Ruling R37。驗證指令以 `--max-num-batched-tokens` 釘住。
      - 原先（6d13987）每人都以上限計，gpt-oss H200 單卡對話的記憶體容量 761 人，Gemma 4 長上下文 sliding 層約為 window 的 9 倍；更正後回到 1368 人與約 1 倍（加每副本一次的預留）。
    - MLX：維持 window 長度，沒有預留。
  - **KV block 配置（2026-10-20，Ruling R37）**：KV 不是逐 token 配置，而是整塊配置；容量（每個常駐序列的穩態、啟動檢查的上限）改以整塊計，decode 每步**讀取**仍是實際 token 數。
    - vLLM：以 block_size 個 token 為一塊（`vllmDefaults.kvBlockSize`）。v0.32.0 `CacheConfig.DEFAULT_BLOCK_SIZE` = 16；沒指定 `--block-size` 時，平台取 attention backend 都接受的最小 block（只有一個 backend 時：預設 16 被接受就用 16，否則取 kernel 支援的最小值）。H100／H200／GB200／GB10 的預設 backend（FA3／FlashInfer／FA2）都接受 16。MLA 依 GPU 與 KV dtype 選 backend（`vllmDefaults.mlaKvBlockSize`）：Hopper FP8 KV → FlashMLA（只有 64）、16-bit KV → FlashAttention MLA（16）；Blackwell → FlashInfer MLA（32／64，取 32）；GB10 → Triton MLA（16）（`docs/research/vllm-tp-kv-precision.md` §3.13）。
      - full 層與 MLA：ceil(上下文 ÷ bs) × bs 個 token（`FullAttentionSpec.max_memory_usage_bytes` = cdiv(max_model_len, bs) 個 block）。
      - sliding 層穩態：min(ceil(上下文 ÷ bs) × bs, window + bs − 1)。推導：`remove_skipped_blocks` 在已處理 c 個 token 時釋放 floor((c − window + 1) ÷ bs) 個**整塊**，下一個 token 配置到第 ceil((c + 1) ÷ bs) 塊；所以序列在 n = c + 1 個 token 時持有 ceil(n ÷ bs) − floor((n − window) ÷ bs) = ceil((window + r) ÷ bs) 塊，r = (n − window) mod bs。r 在序列前進時輪流取 0…bs − 1，持有的 token 平均正好是 window + bs − 1（Hermite 恆等式），最多 bs × ceil((window + bs − 1) ÷ bs)。容量是許多序列的總和，取平均。
      - 上限：見上方啟動檢查（+1 block：window 可能從 block 中間開始）。
      - 進行中 chunk 的預留維持 min(max_in_flight_tokens, 上下文) 個 token，不取整（誤差小於 1 塊 × 層數）。
      - 未建模：個別層的 kernel 限制（例如 Hopper FP8 KV 下 head_dim 512 的 FA4 頁大小 64；Gemma 4 的 full 層）、mamba 混合模型為對齊 mamba 狀態而放大的 block（目錄沒有這類模型）。
      - **依模型選 MLA backend（2026-10-21，最終審查 M26）**：GB200 的 32 只在 qk_nope_head_dim ∈ {64, 128, 192} 時成立（FLASHINFER_MLA 的條件，[`flashinfer_mla.py` L228-L250](https://github.com/vllm-project/vllm/blob/5df63a7203cdb9328d824a27b682e77c7b9928be/vllm/v1/attention/backends/mla/flashinfer_mla.py#L228-L250)）。其他值時 vLLM 依 SM100 優先序（[`cuda.py` L120-L131](https://github.com/vllm-project/vllm/blob/5df63a7203cdb9328d824a27b682e77c7b9928be/vllm/platforms/cuda.py#L120-L131)）試 TOKENSPEED_MLA（只接受 DeepSeek R1 維度與 fp8 KV，所以也不接受）再到 CUTLASS_MLA（block 只有 128，[`cutlass_mla.py` L38-L66](https://github.com/vllm-project/vllm/blob/5df63a7203cdb9328d824a27b682e77c7b9928be/vllm/v1/attention/backends/mla/cutlass_mla.py#L38-L66)）。所以 `mlaKvBlockSize` 可寫 `qkNopeHeadDims` 與 `otherwise`，核心依模型的 qk_nope_head_dim 選用（不再是平台常數）；計算依據列出實際用到的那一個。Hopper 與 GB10 的 MLA backend 沒有這類條件，維持原值。目錄唯一的 MLA 模型 Mistral Small 4（qk_nope 64）結果不變。
    - MLX（mlx-lm v0.32.2）：`KVCache` 每次擴充 256 個 token（`mlxDefaults.kvCacheStep`），full 層與 MLA 持有 ceil(上下文 ÷ 256) × 256；sliding 層的 `RotatingKVCache` 以同樣步長成長到 window 為止，之後維持 window（min(ceil(上下文 ÷ 256) × 256, window)）。
    - 影響：見 §5.2 最後的「2026-10-20 五項補強」掃描。
  - 線性注意力 / 混合架構：每個 sequence 的狀態大小固定
  - **TP 切分後的總量**（2026-10-20 補充，審查 C1／C2）：一個副本有 tp 張卡時，KV 以整個副本的總量計算，容量與 decode 讀取量都用這個值。
    - GQA：KV 頭數 < tp 時，vLLM 會複製 KV 頭（每張卡至少 1 個），所以副本總共存 max(n_kv_heads, tp) 個頭；分層組各自計算。
    - MLA：latent 沒有頭這個維度，每張卡各存一份完整的，所以乘以 tp。
    - Mamba 狀態依頭切分到各卡，總量不隨 tp 改變。
    - 合法 TP（2026-10-20 補充，審查 M-4）：heads % tp = 0，且**每個分層組**的 KV 頭數 K（沒寫時用模型的）都滿足 K % tp = 0 或 tp % K = 0；vLLM 逐層檢查（`docs/research/vllm-tp-kv-precision.md` §1.3、§3.6）。使用者自訂的 GQA 模型另需 heads 為各 KV 頭數的整數倍。
    - 依據：vLLM v0.32.0 `ModelConfig.get_num_kv_heads`（config/model.py L1650-1670）、`QKVParallelLinear`（linear.py L1053-1058）與 MLA 的 `max_tp_shards=1`，見 `docs/research/vllm-tp-kv-precision.md` §1、§2（v0.10.0 起規則相同）。
- **固定開銷**
  - CUDA context、CUDA graphs、通訊緩衝區：依引擎與平台，取自校正設定
  - Prefill 工作區：與 max_num_batched_tokens 相關
- **可用 KV 容量**（每個部署副本）：
  - 公式：HBM × 記憶體利用率 − W / 切分數 − 開銷
  - 可用容量 ÷ 每 token KV 大小 → 可容納的 KV token 總數
  - 可容納 token ÷ 每個 sequence 的平均 context → 記憶體決定的最大同時數
  - 有 prefix cache 時，共享的系統提示詞只計一次。
  - **記憶體單位與 vLLM 預算（2026-10-20 補充，已知簡化）**：
    - 計算機的 HBM 用廠商標示的十進位 GB（`memGB` × 1e9 bytes），偏保守。
    - vLLM 的預算是 `ceil(cudaMemGetInfo total × gpu_memory_utilization)`，再扣權重、activation 峰值（以 `max_num_batched_tokens` profile）、NCCL／cuBLAS 等非 torch 記憶體與 CUDA graph 估計，剩下的才是 KV（`docs/research/vllm-tp-kv-precision.md` §5.2–5.3）。H100 80GB 的 cudaMemGetInfo total 約 85.0e9 bytes，比 80e9 多約 6%。
    - 計算機的公式 HBM × memUtil − W 沒有扣 activation、非 torch 與 CUDA graph 開銷；十進位 GB 的低估與這些未建模的開銷大致抵銷，但兩者都**尚未實測**，待國網量測校正（GitHub issue #10，以啟動日誌的「Available KV cache memory」為準）。
    - vLLM 平台的 memUtil 採 v0.32.0 預設 0.92（v0.10.0 為 0.9），驗證指令一律以 `--gpu-memory-utilization` 釘住同一個值。
- **Mac**
  - 統一記憶體要扣除系統保留（設定檔），並套用 macOS GPU 可用上限（wired limit）。

### 5.2 Decode（每步）

這一節是講義 Roofline 模型 [R-LEC] 的直接應用。

```
t_step(B) = max( bytes(B) / (BW × η_bw),  flops(B) / (Peak_dtype × η_compute) ) + t_comm(B) + t_fixed
bytes(B)  = 本步實際讀取的權重 + Σ_batch 各 sequence 的 KV
flops(B)  = 2 × 啟用參數 × B + 注意力計算 (≈ 4 × L × d_attn × ctx，逐 sequence 加總)
```

- **2026-10-19 注意力項更正（Ruling R33）**：上式「4 × L × d_attn × ctx」原本對每一層都用完整 ctx。現在注意力 FLOPs 依分層設定逐組計算，和 §5.1 的 KV cache 一致：full 層注意 ctx 個 token，sliding window 層注意 min(ctx, window) 個，mamba 層沒有注意力（不計）；查詢頭數一律用模型的 heads（分層設定只給 KV 頭數），每頭維度用該組的 headDim（沒寫時用模型的）。MLA 與沒有分層設定的模型維持 L × ctx（只設定 slidingWindow、沒有分層時，每層取 min(ctx, window)）。decode 每步、prefill 干擾與 TTFT 都用這個值。Llama 這類沒有分層設定的模型結果不變；gpt-oss、Gemma 4 這類 sliding／full 混合模型在長上下文時注意力 FLOPs 變小。
- **2026-10-20 MLA 注意力項更正（審查 L7）**：vLLM 的 MLA 有兩條路徑（v0.32.0 `mla_attention.py` L12-16、L65-117，依 DeepSeek-V2 論文 arXiv 2405.04434）。
  - decode 走吸收後的 MQA 路徑：每個查詢頭的 QK 維度為 kv_lora_rank + qk_rope_head_dim，V 維度為 kv_lora_rank，所以每層每個被注意的位置是 2 × heads × (2 × kv_lora_rank + qk_rope_head_dim) FLOPs。Mistral Small 4（256、64）為 2 × 32 × 576，是原本 4 × 32 × 128 的 2.25 倍。
  - prefill（含 chunked prefill 干擾與 TTFT）走運算友善的 MHA 路徑（`forward_mha`）。2026-10-20 改為精確值（Ruling R40，取代原本的 4 × heads × headDim 近似）：QK 每頭維度 qk_nope_head_dim + qk_rope_head_dim、V 每頭維度 v_head_dim（v0.32.0 `mla_attention.py` L65-91；`qk_head_dim` L485、`v_head_dim` L473；chunked prefill 也用這條路徑，L120-123），所以每層每個被注意的位置是 2 × heads × (qk_nope + qk_rope) + 2 × heads × v_head_dim FLOPs。`mla` 設定新增 `qkNopeHeadDim`、`vHeadDim`，由 HF importer 讀 config.json 的 `qk_nope_head_dim`、`v_head_dim`（Mistral 格式的 params.json 用同名鍵），缺少時視為缺欄位。
    - Mistral Small 4（qk_nope 64、qk_rope 64、v 128、headDim 128）：2 × 32 × 128 + 2 × 32 × 128 = 4 × 32 × 128，與原近似相同，結果不變；DeepSeek-V3 類（128、64、128）會是原近似的 1.25 倍。
    - 未計：context 的 latent 上投影（`_compute_prefill_context` 以 `kv_b_proj` 把快取的 kv_c 展開成 K／V）的 FLOPs；以及 vLLM 把很短的 prefill 交給 decode 路徑（FlashMLA `reorder_batch_threshold` 128、FlashAttention MLA 512 個 token 以下，`flashmla.py` L113、`flashattn_mla.py` L130），那時實際走吸收後的 MQA 路徑。
- **2026-10-20 參數項更正（審查 L8）**：「2 × 啟用參數」改為只算真正做矩陣乘法的參數 [R-LEC B8]。
  - 線性層參數 = 啟用參數 − embedding／lm_head 參數（vocab × hidden × 共用 1／不共用 2）。每個 token 都要乘一次。
  - 輸入 embedding 只是查表（取 B 列），沒有 FLOPs。
  - lm_head（vocab × hidden；共用時就是同一個矩陣）只對要取樣的 token 計算：decode 每個 token 都算；prefill 每個序列只算最後 1 個 token（vLLM v0.32.0 `gpu_model_runner.py` L4241-4242：`compute_logits(hidden_states[logits_indices])`）。
  - 所以 decode 每 token = 2 ×（線性層 + lm_head）+ 注意力；prefill 每 token = 2 × 線性層 + 注意力，每個序列另加 2 × lm_head。沒有 vocabSize 的自訂模型不變。
  - 讀取位元組（2026-10-20 更正，Ruling R39；取代 a55145f 的「已知小幅高估」）：權重**記憶體**照舊含整張 embedding；每步**讀取**的輸入 embedding 只有查到的列。
    - 不共用（tieWordEmbeddings false）：一步處理 T 個 token（decode 的 B + 同一步的 prefill token；TTFT 每段的段 token 數）只讀 min(T, vocab) 列，讀取量 = 其他權重全讀 + min(T, vocab) × hidden × embeddingBytesPerParam；lm_head 每步全讀。
    - 共用：同一個矩陣也是 lm_head，每步全讀一次（不重複計）。
    - 原生 checkpoint 一樣：輸入 embedding 不在任何量化範圍內（vLLM 的 FP8／MXFP4 只量化 Linear／MoE；gpt-oss 的 `modules_to_not_convert` 含 `model.embed_tokens`），以量化格式的 `embeddingBytesPerParam`（2）計，從 checkpoint 大小中扣掉整張表再加回讀到的列。
    - 影響：不共用 embedding 的模型在低併發時每步少讀約 vocab × hidden × 2 bytes，例如 Mistral Medium 3.5 少 3.22 GB（133.61 → 130.39 GB + KV）、gpt-oss-120b 少 1.16 GB。`mac-mlx` 的 η_bw 由同一個 decode 讀取量反推，依其公式重算：etaBw 0.88 → 0.86（7.70 tok/s × 133.37 GB ÷ 1.2 TB/s）、etaBwLow 0.83 → 0.81，fit 點的預測維持 +0.5%；`mac-mini-mlx` 沿用相同數值。
- **t_fixed（2026-10-20 實作，審查 L4）**：每步與工作量無關的固定時間（kernel 啟動、排程、管線填充；[R-LEC G2] 只有定性依據）。取自校正設定的 `tFixedSec`，decode 每步加一次，TTFT 每個 prefill 段加一次。值為 0 時不列入計算依據，也不影響可信度標記。2026-10-20 起 `nvidia-default` 為 2.9 ms（derived，Ruling R41，見 §5.6）；MLX 與 DGX Spark 仍為 0：這是未量測的佔位值（unmeasured placeholder，status estimate；evidence 是記錄「尚未量測」的 GitHub issue #12，不是支持 0 的來源；2026-10-21 更正，最終審查 M20，原本誤寫為當時的 issue #1（H100／H200，現為 #10）並以不相干的量測當 evidence）。
- **MoE 讀取的權重**：每層在 batch B 下，預期被觸發的專家數 = E × (1 − (1 − k/E)^B)。B 小時接近只讀啟用參數，B 大時接近讀全部專家。這比 Mac 計算機用的「1.3 倍修正係數」[R-PRIOR] 更有根據。式中的 B 是**本步路由的 token 數**：B 個 decode token 加上同一步的 prefill token，因為 chunked prefill 的 token 也經過同一次路由（2026-10-20 更正，審查 L6）。
  - **混合期望（2026-10-20 再更正，審查 L6 修正）**：f(T) = 1 − (1 − k/E)^T 是凹函數，代入平均 prefill token 數 P̄ = max(0, B − 1) × 新輸入 ÷ 輸出（§5.3）會高估觸及的專家（Jensen：f(E[T]) ≥ E[f(T)]）。prefill 實際上是某一個 request 的整段未快取 token（一個 chunk = min(新輸入, max(1, max_num_batched_tokens − B))，B 個 decode token 先排，Ruling R38；推論引擎沒有這個上限時為新輸入），只出現在一部分步數。所以 p = min(1, P̄ ÷ chunk)，E[觸及比例] = p × f(B + chunk) + (1 − p) × f(B)；P̄ ≥ chunk 時每步都帶 P̄ 個 prefill token，取 f(B + P̄)。B = 1 或沒有 prefill 時就是 f(B)。權重讀取量對觸及比例是線性的，所以期望位元組照這個比例算；FLOPs、all-reduce 位元組（審查 L2）與 KV 讀取量對 token 數是線性的，平均值就是精確的期望，維持用 B + P̄。影響：Mistral Small 4 在 Mac Studio 對話 50 人從 25 台回到 4 台；gpt-oss-120b 200 人對話在 Mac Studio 從 34 台變 6 台、DGX Spark 從 200 台變 100 台。
- **預填排隊模型（2026-10-20，Ruling R36，取代 R35 的「會排隊標記」）**：R35 只在 B + P̄ 超過 vLLM 每步 token 上限時標記、不改變結果；那樣每步時間算進了排不進去的 prefill token（速度偏悲觀），又漏了排隊等待（TTFT 偏樂觀）。現在把排隊建模：
  - **依據**：vLLM 每步的 token 預算 max_num_batched_tokens（每個副本／DP rank 各自計；H100／H200 的 API server 預設 8192、GB200 16384）由 decode 與 prefill chunk 共用；scheduler 先排 running 的 request，預算有剩才從 waiting queue 取 request 做 prefill，排不進的留在 waiting queue（`docs/research/vllm-tp-kv-precision.md` §7.1、§7.2、§7.5）。
  - **模型（封閉迴路）**：每副本 B 個生成中的請求（對話 = 人數，研究助理 = 同時生成的請求，§8.3.3）。每個請求解碼 輸出 個 token 後，立刻送出下一個請求，需要 新輸入 = 輸入 × (1 − 快取命中率) 個未快取 prefill token。D 個請求同時解碼時，每步完成 D ÷ 輸出 個請求，帶進 D × 新輸入 ÷ 輸出 個 prefill token，所以每步需要 D × (1 + 新輸入 ÷ 輸出) 個 token。這是全體的流量平衡：預算計入本步的**所有** token，包括使用者自己下一輪的 prefill，所以用 D 而不是 §5.3 的 B − 1（B − 1 是某一位使用者解碼時看到的「其他人」的干擾，用在每步時間）。因此最多 D_max = max(1, floor(上限 × 輸出 ÷ (輸出 + 新輸入))) 個請求同時解碼（至少 1 個：單一請求的 prompt 分成多個 chunk 依序做）。門檻：對話 919、研究助理 363（同時生成的請求）、長文件 227（H100／H200）。
  - **B ≤ D_max**：沒有排隊，數值與 R35 時完全相同（計算依據多列排隊規則）。
  - **B > D_max**：只有 D_max 個在解碼，B − D_max 個在 waiting queue 等 prefill。每步時間 t_step 與每人速度（1 ÷ t_step）都以 D_max 個解碼計（沿用 §5.3 的干擾項，所以剛好在門檻時連續）。完成率 λ = D_max ÷ (輸出 × t_step)；依 Little's law（L = λW；J. D. C. Little, "A Proof for the Queuing Formula L = λW", *Operations Research* 9(3), 383–387, 1961）對 waiting queue，平均等待 W = (B − D_max) ÷ λ = (B − D_max) × 輸出 × t_step ÷ D_max。正在做 prefill 的那個請求已算在 TTFT 的 prefill 時間裡，所以 W 只算排隊的人。
  - **TTFT** = §5.3 的 prefill TTFT（含頻寬項、TP 通訊、t_fixed）+ W；速度目標檢查解碼中的請求，TTFT 目標檢查 TTFT + W。所以排隊讓 TTFT 超標時，求解器會加副本；排隊卻讓速度不再被高估的 prefill 拖慢，有些情境 GPU 反而變少（見下方影響）。總吞吐 = D_max ÷ t_step。
  - **記憶體**：照舊以全部 B 人（研究助理：全部常駐工作階段）計 KV。vLLM 新進的 waiting request 不持有 KV block（§7.5），但前一輪的上下文仍在 prefix cache 裡；快取命中率的假設本來就要求它留在記憶體，排隊時把它逐出會讓 prefill 變長。所以全部計入是一致且保守的做法。
  - **假設與限制**：封閉迴路、確定性的流體近似，沒有到達的突發與長度的變異，所以 W 是實際平均等待的**下限**，P95／P99 會更長（尾端餘裕留到 Plan 5，§12）。研究助理把「同時生成的請求數」當成固定的 B；實際上排隊越久，同時在請求中的工作階段會越多。MLX（Mac）沒有每步上限，不排隊（W = 0）。每副本同時生成的請求超過 max_num_seqs 時也會排隊，但驗證指令已經以 `--max-num-seqs` 調高（§5.6），所以不另外建模。
  - **輸出**：結果帶 `queueing: { tokensPerStep, budget, decodingMax, waiting, waitSec, reason }`，tokensPerStep = B × (1 + 新輸入 ÷ 輸出)（需求），沒有排隊、不可行或 MLX 時為 null。評估過排隊（vLLM 平台上有選出的形狀）的結果，在計算依據列出平台的 max_num_batched_tokens 與 `concurrency.queueRule`（推估：Little 1961 + vLLM scheduler），可信度標記照常傳遞。有排隊時驗證指令加上 `--max-num-batched-tokens` 與一行註解：量到的 TTFT 包含排隊時間；`vllm bench serve --max-concurrency` 是封閉迴路（每完成一個才送下一個，§7.3），與模型相同，但開頭會一起送出，前幾個請求等得更久。
  - **可服務人數的單調性**：每副本的生成與常駐人數隨 n 不減；每步時間到 D_max 為止遞增、之後固定；W 隨排隊人數遞增。所以可行性對 n 仍是單調的，最大人數的二分搜尋成立；對副本數也單調（副本越多，每副本越少人），最少 GPU 的二分搜尋也成立。
  - **影響（全目錄掃描：13 個模型 × 原生／FP8 × 3 種負載 × 2 種速度 × 1／50／200／1000／5000 人 × 8 個平台）**：6240 個結果中 300 個改變，沒有可行性翻轉；80 個 GPU 數改變（61 個減少、19 個增加）。例如 Mistral Small 4 長文件在 4 張 H100 的可服務人數從 228 變 292（227 人解碼維持 20.16 tok/s，TTFT 0.072 + 排隊 4.87 秒受 5 秒限制；記憶體上限 304）；同模型對話 5000 人在 H100 從 14 張變 12 張；gpt-oss-120b FP8 長文件「可接受」5000 人在 H100 從 28 張變 40 張（原本 8 tok/s 的慢步伐讓排隊超過 15 秒）。
- **每人速度**：1 / t_step(B)；**總吞吐**：B / t_step(B)。兩者對 B 畫出來，就是速度 vs. 人數曲線。
- **校正係數**：η_bw、η_compute 依「平台 × 推論引擎」取自校正設定。例如 Mac MLX 大型 dense 模型 η_bw ≈ 0.75–0.85 [R-MAC]。區間的上下界就是結果區間的來源。推論引擎寫在校正設定的 `engine`（`vllm`／`mlx`），驗證指令與引擎專屬的記憶體規則都依它決定，不再由硬體有哪些 TFLOPS 欄位推斷（2026-10-20 補充，審查 M-6）。

- **2026-10-20 五項補強（Ruling R37–R40 與 vLLM 出處改釘 v0.32.0）的影響**：與 §5.2 R36 相同的全目錄掃描（13 個模型 × 原生／FP8 × 3 種負載 × 2 種速度 × 1／50／200／1000／5000 人 × 8 個平台），6240 個結果中 1854 個改變；GPU 數改變 76 個（54 個減少、22 個增加），可行性翻轉 10 個。
  - 依項目：KV block 配置（R37）386 個；chunked prefill 逐段（R38）240 個；輸入 embedding 只讀查到的列（R39，含 mac-mlx η_bw 依公式重算）1351 個；MLA prefill 精確 FLOPs（R40）0 個（Mistral Small 4 的維度剛好等於原近似）；出處改釘只改變驗證指令（`--quantization fp8_per_tensor`）與說明文字，數值不變。
  - 最大的改變來自 R39：不共用 embedding 的 MoE 模型在低併發時每步讀取量以 embedding 為大宗，例如 gpt-oss-20b 原生在 H200 單人 684.6 → 896.1 tok/s（+31%），使 Mac mini／DGX Spark 上的 gpt-oss-20b 每台能服務的人數變多，5000 人的台數最多減半（Mac mini M6 FP8 對話 5000 → 2500 台）。
  - 可行性翻轉全部是 Mac mini M5 Pro 上原本剛好達標的情境：mac-mini-mlx 沿用的 η_bw 由 0.88 降為 0.86，Gemma 4 12B FP8 對話（流暢）20.30 → 19.84 tok/s、Gemma 4 31B FP8 對話（可接受）8.05 → 7.87 tok/s，低於速度目標（Gemma 4 的 embedding 共用，R39 沒有好處）。
  - R37 的 block 取整讓記憶體上限人數小幅減少，在門檻附近會多一個副本，例如 gpt-oss-20b FP8 長文件 1000 人在 H100：3 張可服務 1002 → 999 人，改為 4 張；最少 GPU 數因而多 1 張時，新的 GPU 數上有好幾種形狀，同 GPU 數的平手（R34）改選服務人數最多的那個，例如 Gemma 4 31B FP8 對話（可接受）5000 人在 H200：R37 前 23 × TP1（23 張）可服務 5014 人；整塊配置後 23 張不到 5000 人，最少要 24 張，而 24 張的切法中 3 × TP8 可服務的人數最多（5784 人，24 × TP1 較少），所以選它（首字 0.06 → 11.1 秒，含排隊，仍在 15 秒內）。這不是同 GPU 數的平手換了形狀，而是 GPU 數從 23 變 24 後在新的 GPU 數上依 R34 選形狀（2026-10-21 更正，最終審查 M29）。
  - README 範例（gpt-oss-120b 對話 200 人）數值不變。

### 5.3 Prefill 與 TTFT

- **Prefill 時間** = (新 token 數 × (2 × 線性層參數 + 注意力項) + 2 × lm_head 參數) / (Peak × η_prefill)（線性層參數見 §5.2 審查 L8）
  - 新 token 數 = prompt 長度 × (1 − 快取命中率)
  - **頻寬項（2026-10-20 補充，審查 L1）**：prefill 也是 Roofline，時間 = max(上式, 讀取位元組 ÷ (BW × η_bw)) [R-LEC B1, B7, B9]。讀取位元組 = 權重讀一次（prefill 是 GEMM，輸出 tile 涵蓋所有 token，每個權重 tile 只取一次，B9；MoE 取新 token 觸及的專家比例）+ 這個序列在輸入長度的 KV（讀取已快取的前綴、寫入新 token）。快取命中率高時新 token 很少，這一項會成為瓶頸。
  - **Chunked prefill 逐段計算（2026-10-20，Ruling R38，取代上一點「未建模」的說法）**：prefill 不是一次做完，而是分成 n = ceil(新 token 數 ÷ chunk) 步，每一步各自是一次 forward，權重在每一步都要重讀（步與步之間晶片上不留權重，[R-LEC B6]）。所以 Roofline 改為**逐段**：TTFT 的 prefill 部分 = Σ_段 [max(段 FLOPs ÷ (Peak × η_compute), 段位元組 ÷ (BW × η_bw)) + 段 TP 通訊 + t_fixed]。
    - 段 FLOPs = 段 token 數 × (2 × 線性層參數 + 段平均位置的注意力項)，lm_head 只在最後一段（取樣的那 1 個 token）。
    - 段位元組 = 權重重讀一次（MoE：這一段 token 觸及的專家比例）+ 到這一段結尾為止的 KV（讀取前綴與前面各段、寫入本段）。
    - 每段各付一次 all-reduce（訊息 = 段 token 數 × hidden × 2 bytes）與一次 t_fixed。
    - chunk 大小：vLLM 的 scheduler 先排 RUNNING 的 decode request，剩下的預算才給 prefill（`docs/research/vllm-tp-kv-precision.md` §7.5），所以 chunk = max(1, max_num_batched_tokens − (D − 1))，D = 解碼中的請求數，與排隊模型（R36）的 min(B, D_max) 相同；減 1 是因為這位使用者自己在 prefill，不在解碼（R29）。D ≤ D_max 時 chunk ≥ max_num_batched_tokens × 新 token 數 ÷ (輸出 + 新 token 數) + 1，所以一個 prompt 最多約 (輸出 + 新 token 數) ÷ max_num_batched_tokens + 1 段；下限 1 只防範這個模型以外的輸入。MLX：mlx_lm.server 以 `--prefill-step-size`（預設 2048）切段，不看 decode 負載（`mlxDefaults.prefillStepSize`）。沒有這兩者時一次做完。
    - 與 TTFT 定義的關係：TTFT 仍是「這一位使用者的 prefill 工作量」（R29）；同一步裡其他人的 decode 工作沒有加進 TTFT（他們的 KV 讀取與 FLOPs 在各自的每步時間裡）。段很大時每段都受算力限制，各段 FLOPs 加總等於一次做完（full 層注意力對位置是線性的），差別只在每段的 all-reduce 延遲與 t_fixed；段很小（decode 很多、預算所剩無幾）或快取命中率高時，權重重讀成為主導。
    - decode 步的 MoE 混合期望（§5.2，審查 L6）用同一個 chunk 上限：chunk = min(新輸入, max(1, max_num_batched_tokens − B))（B 個 decode token 先排）。
    - **負載下的物理下限（2026-10-20 補充，最終審查 M6；修訂本 Ruling R38）**：上面的逐段 Roofline 只算這位使用者的 prefill 工作量（R29），但有其他 D − 1 個請求同時解碼時，每一段都是一個完整的 engine step。vLLM 的 chunked prefill 與 decode 在同一次 forward（§5.2），那一步至少要花 decode 的每步時間，所以每段時間 = max(段 Roofline + 段通訊 + t_fixed, t_step(D))；只有 1 人（D = 1）時沒有下限，c = 1 的校正點不變。這不是把別人的工作量加進 TTFT（R29 仍成立），只是一步不可能比它所在的 batch 更快完成。影響：高 batch、算力受限時明顯，例如 Llama 70B FP8 在 8 張 H200、919 人同時解碼的對話，首字的 prefill 從 0.018 秒（只算自己的 1020 token）變為 t_step(919) ≈ 0.147 秒。MLX 的做法不同，見下一點。
    - **MLX 的 prefill 是另一次 forward（2026-10-20，最終審查 M5）**：mlx-lm v0.32.2 `BatchGenerator._next` 每輪先跑 generation batch 的 decode forward，再以**另一次** forward 處理 prompt batch 的下一段（每個 prompt 最多 prefill_step_size 個 token）（[`mlx_lm/generate.py` L1812-L1889](https://github.com/ml-explore/mlx-lm/blob/93e6d4a6447b3080861985947f0820e76fcb957d/mlx_lm/generate.py#L1812-L1889)；server 以 `--decode-concurrency`、`--prompt-concurrency`、`--prefill-step-size` 建立它，[`server.py` L912-L917](https://github.com/ml-explore/mlx-lm/blob/93e6d4a6447b3080861985947f0820e76fcb957d/mlx_lm/server.py#L912-L917)）。所以 Mac 上：
      - decode 每步 = decode forward（B 個 decode token 的 Roofline：權重讀取以 B 個 token 計、B 個序列的 KV、decode FLOPs）+ p × 一次 prefill pass（自己的 Roofline：重讀權重（MoE：這段 token 觸及的專家）、這些 prompt 的 KV、prefill FLOPs）；chunk = min(新輸入, prefill_step_size)，p = min(1, P̄ ÷ chunk)（P̄ ≥ chunk 時每步都有 P̄ 個 token 的 pass）。原本 Mac 也套用 vLLM 的「同一次 forward、權重只讀一次」，低估了 prefill 干擾；MoE 混合期望在 Mac 上因此不再用（decode 與 prefill 各自觸及自己的專家），最終審查 M5 要求的「以 prefill_step_size 為混合的 chunk 上限」改由這個模型取代。
      - TTFT：每一段之前都先跑其他人的 decode forward，所以負載下每段加上一次 decode forward 的時間（M6 在 MLX 上的形式，是相加而不是取 max）。
      - 未建模：prompt_concurrency（每次 pass 最多 8 個 prompt）與 decode_concurrency（預設最多同時解碼 32 個，驗證指令會在超過時釘住）的上限，以及 prompt 最後 1 個 token 在 generation step 才處理（多一次 decode forward）。
    - **影響（2026-10-21 全目錄掃描，與 R41 相同的 6720 個結果，最終審查各項修正後）**：1336 個改變，沒有可行性翻轉。
      - NVIDIA（H100、H200、GB200、DGX Spark）：GPU 數 0 個改變；630 個只有首字時間變長（M6 的負載下限，最多 +0.11 秒），25 個只有 maxConcurrent 小幅減少。README 範例（gpt-oss-120b 對話 200 人）H200 首字 0.10 → 0.11 秒、H100 0.09 → 0.10 秒，GPU 數不變。
      - Mac（M5）：462 個台數增加、0 個減少，最多約 9 倍：prefill 不再藏在 decode 的頻寬時間裡，每人速度剛好在目標附近的情境就要拆到更少人一台，例如 Mistral Small 3.1 24B（BF16）對話（流暢）在 Mac Studio：每台 2 人時每步多出 p × 一次 1020 token 的 prefill pass，19.6 tok/s（1 人時 22.0）低於 20，所以 200 人從 23 台變 200 台；README 範例 gpt-oss-120b 對話 200 人在 Mac Studio 從 6 台變 12 台（21.6 tok/s、首字 0.17 秒）。Mac 的校正點都是 1 人（沒有 prefill 干擾），數值不變。
  - Agent 類的快取命中率預設約 95% [R-TASK]，影響極大，必須是顯性參數。
- **Prefill 佔用的算力必須計入 decode 的每一步**：在穩態下，每產生 1 個輸出 token，平均還要讀入（新輸入長度 ÷ 輸出長度）個 token。這部分計算和 decode 共用算力（chunked prefill）。草稿 v6 測試時發現，漏算這一項會讓一般對話的容量高估約 9 倍：一個 H200 node 跑 70B FP8 對話，從約 2,700 人同時降到約 311 人。
  - **2026-10-19 校正更正（Ruling R29）**：上面「每產生 1 個輸出 token 要讀入的 token」只來自**其他**同時在生成的人。某個人自己的 prefill 發生在他開始 decode 之前，已算在 TTFT 裡，不會拖慢他自己的每個 token。所以每一步的 prefill 量改為 max(0, B − 1) × (新輸入長度 ÷ 輸出長度)，原本寫的是 B ×；B = 1 時沒有 prefill 項。這個錯誤是 Apple M5 Ultra 跑 Mistral Medium 3.5 128B FP8、8K 輸入、同時 1 人的校正點發現的：舊公式把單人 decode 算成 compute-bound，預測 3.75 tok/s，實測 7.70（−51%）。人數多時影響約 1/B。上例 70B FP8 H200 node 從 311 人變為 312 人，§8.3.3 的 622 變為 624。
- **TTFT** = 排隊等待 W + prefill 時間 + TP 通訊
  - 排隊等待（2026-10-20 建模，Ruling R36，§5.2）：vLLM 每副本最多 D_max = max(1, floor(max_num_batched_tokens × 輸出 ÷ (輸出 + 新 token 數))) 個請求同時解碼；生成中的請求 B 超過 D_max 時，W = (B − D_max) × 輸出 × t_step(D_max) ÷ D_max（Little's law，Little 1961），否則 W = 0；MLX 沒有上限，W = 0。
  - TP 通訊（2026-10-20 補充，審查 L3）：tp > 1 時 prefill 的 row-parallel 層也要歸約部分和 [R-LEC F2, F3]，每層 2 次 all-reduce，訊息 = 新 token 數 × hidden × 2 bytes，時間依 §5.4 的 α-β 模型，加在 max() 之外。分段時每段各算一次（Ruling R38）。
  - Chunked prefill 和 decode 共用 GPU 時，decode 步會被拖慢。依「prefill token 佔每步預算的比例」修正 t_step。
- **Mac 的 prefill** 用實測有效 TFLOPS，不用峰值 [R-MAC]。

### 5.4 平行化與通訊

- **部署副本**的組成是 TP × PP（MoE 加上 EP），副本數 = DP。
- **限制**
  - TP 不跨越 NVLink 網域：
    - HGX H100 / H200 為 8 卡
    - GB200 NVL72 為 72 卡，但國網排程上單一工作不跨機櫃 [R-HW]
    - Mac 只能透過 TB5 RDMA 做 full mesh，有台數上限 [R-MAC]
  - 跨網域只能用 PP 或 DP。
- **All-reduce 成本**用 α-β 模型：
  - ring all-reduce：2(p−1)/p × 訊息大小 / 鏈路頻寬 + 2(p−1) × α
  - 實作上的延遲項：設定檔的 `allreduceLatencyUs` 是**整次小訊息 all-reduce 的實測時間**（已包含 2(p−1) 個 α），所以直接當成單一延遲項使用：`latency + 2(p−1)/p × bytes / bwPerDir`。若日後改存單跳 α，才改回乘以 2(p−1)。（2026-10-19 實作時更正）此實測值只在量測時的 GPU 數下成立：GB200 的 NCCL 數據是 4 張 GPU（p = 4）。用在 TP=2 會略為高估（實際只有 2 個 α）；日後若開放 TP=8 或跨 node，需要另一個在該 GPU 數（或跨 node）量測的值。目前 H100 / H200 的 nvidia-default 設定也沿用這個 4-GPU 值，TP=8 時屬外推，可能低估。（2026-10-19 補充，Ruling R23）
  - 每層 2 次，訊息大小 = 本步 token 數 × hidden × bytes [R-LEC F3]。decode 的本步 token 數 = B + 同一步的 prefill 干擾 token max(0, B − 1) × 新輸入 ÷ 輸出（2026-10-20 更正，審查 L2：原本只算 B）；TTFT 的 prefill 為新 token 數（見 §5.3）
  - 鏈路頻寬與延遲 α 取自硬體設定：NVLink、IB NDR、TB5 RDMA
  - 其中延遲多為實測或第三方數據，必須帶出處標記 [R-HW][R-MAC]。
- **PP**：decode 時每經過一個 stage 增加一次點對點傳輸延遲。吞吐受 micro-batch 填滿程度影響。
- **多台 Mac**：tensor parallel 用上述模型計算，並以 Apple 公布的 2 台 / 4 台實測倍數 [R-MAC] 作為校正對照。
- **自動選配置**：自動挑選 TP / PP / DP 組合，使用者也可在進階設定手動指定。

### 5.5 求解

- **正向（負載 → 硬體）**：對每個平台，在合法的副本形狀中，找出同時滿足以下條件、**GPU 總數最少**的配置（配置單位為張 GPU，見 10.2）：
  - 每人上下文（輸入 + 輸出）不超過模型的最大上下文，否則判定不可行（`why: 'context'`），也不產生驗證指令（2026-10-20 補充，審查 C3）
  - 記憶體放得下
  - 在同時數 C 下符合服務目標（TTFT 上限、每人 tok/s 下限）。TTFT 含 vLLM 每步 token 上限造成的排隊等待 W，每人速度是解碼中請求的速度（2026-10-20，Ruling R36，§5.2）；W 讓 TTFT 超標時就加副本
  - 1 人是否可行要檢查每一種合法 TP，不只最大的 TP：all-reduce 會讓大 TP 變慢，MLA 在大 TP 也更佔記憶體（2026-10-20 補充）
  - 保留餘裕（headroom）**尚未實作**（2026-10-21 更正，最終審查 M29）：目前沒有設定檔的餘裕係數，求解直接以平均值對服務目標；排隊等待 W 是封閉迴路流體近似的下限（`concurrency.queueRule` 的依據），P95／P99 的尾端餘裕留到 Plan 5
  - **同 GPU 數的平手（2026-10-20 補充，Ruling R34，審查 M-7）**：GPU 總數相同的形狀（例如 1 × 4 與 4 × 1），取**可服務人數最多**的那個（同一 η 下的最大同時人數），再相同才取較小的 t。反向推算在同樣的 GPU 數下取人數最多的切法，所以兩個方向對同一組 GPU 會選出同一個形狀；原本平手一律取較小的 t，會與反向推算矛盾。
- **反向（硬體 → 容量）**：給定配置，求出：
  - 記憶體上限人數
  - 符合服務目標的最大人數
  - 1 到上限之間每個人數對應的速度曲線
  - 實作（2026-10-20，最終審查 I3）：`estimateCapacity` 回傳記憶體上限人數（`memoryOnlyMax`，同樣 GPU 的最佳切法、不套速度目標）、瓶頸（`bottleneck`：多 1 人時先違反的條件，`'mem'`／`'bw'`／`'compute'`／`'ttft'`）、1 到上限之間 8 個人數的速度曲線（`speedCurve`：每人 tok/s、總 tok/s、TTFT，含形狀）、驗證指令，以及可服務 0 人時的原因（`why`／`detail`，含 `'context'`）。可服務人數達到搜尋上限 1e7 時標 `saturated`，文字寫「至少」（最終審查 M15）。
- **選模型**：給定硬體與服務目標，列出可行的「模型 × 量化」組合。每一項帶原因代碼與文字（`why`／`detail`）、瓶頸、驗證指令；有部署時另帶最少 GPU 形狀的最大人數、記憶體上限人數與速度曲線（2026-10-20，最終審查 I3）。
- **輸出**：每個結果都包含預期值與保守值（用 η 區間的下界）、瓶頸類型（記憶體容量 / 頻寬 / 算力 / 通訊），以及計算依據。正向推算的每個平台結果另有自己的計算依據與可信度標記（只含該平台實際用到的值）；整體的計算依據是各平台的聯集（2026-10-20 補充，審查 M-11）。

### 5.6 準確度與驗證

- **Golden tests**：每條公式都要有手算範例的單元測試。
- **校正測試**：用已公開的實測數據比對預測值，誤差超過設定的容忍度就讓 CI 失敗。初始數據包括：
  - Apple MLX 官方 2 台 / 4 台數據
  - Geerling M3 Ultra 70B
  - DGX Spark 上 Llama 3.1 8B（FP8 / BF16）與 Mistral Small 3.1 24B 的實測（StorageReview）
  - NVIDIA H100／H200 自 2026-10-20 起有 InferenceX 的公開實測點（Ruling R41，見下）；GB200 仍沒有符合條件的公開實測點，待國網實測補上。
  - vLLM 啟動 log 顯示的最大並發數
- **準確度頁**：網站上有一頁「準確度」，公開以上比對結果。做法比照 ApX [R-PRIOR]。
- **驗證指令**：每個結果都附上可直接執行的驗證指令，例如 `vllm bench serve --max-concurrency N ...`。
  - 驗證指令必須重現估算的情境（2026-10-19 補充）：`vllm serve` 帶上 TP、量化格式的啟動參數（`config/quantization.yaml` 的 `vllmServe`：fp8 → `--quantization fp8_per_tensor`（2026-10-20 更正：v0.32.0 的 `--quantization fp8` 線上量化已棄用、會轉成 fp8_per_tensor），bf16 → `--dtype bfloat16`，int4-awq → `--quantization awq`（v0.32.0 `auto_awq` 的別名）並以 `<AWQ checkpoint of …>` 佔位、附說明）、FP8 KV 時的 `--kv-cache-dtype fp8`、`--gpu-memory-utilization`（校正設定的 memUtil）與 `--max-model-len`（輸入 + 輸出）。Mac 的 mlx_lm 沒有這些參數，改在註解寫出估算的假設。
  - 不可行情境（2026-10-20 補充，審查 M-8）：權重放得下、但記憶體、速度或 TTFT 不達標時，仍在最大合法 TP、1 個副本上產生驗證指令，並以 verifyNote 寫明「預期不可行」與原因，指令用來確認這個判斷。沒有合法 TP、權重放不下、上下文超過上限或需要另取 checkpoint 時，沒有指令，只有 verifyNote。
  - vLLM 預設值與多副本（2026-10-20 補充，審查 L9／L10）：sliding window 層進行中 chunk 的預留以平台的 max_num_batched_tokens 估算時，或情境會排隊時（Ruling R36，§5.2；附註解說明量到的 TTFT 包含排隊時間），指令加上 `--max-num-batched-tokens`；每個副本同時生成的請求數超過平台 vLLM 預設的 max_num_seqs（v0.32.0：H100／H200／GB200 為 1024）時加上 `--max-num-seqs`，否則多出的請求會在伺服器排隊。
    - **2026-10-20 更正（最終審查 M9）**：`--max-num-batched-tokens` 改為 vLLM 指令一律釘住平台的值：chunked prefill 的分段（Ruling R38）、排隊模型（R36）與 sliding window 的預留都依它計算，與 `--gpu-memory-utilization`「釘住、不依賴版本預設」的理由相同。
    - **2026-10-20 更正（最終審查 I1）**：vLLM 要求 max_num_batched_tokens ≥ max_num_seqs，否則拒絕啟動（v0.32.0 [`vllm/config/scheduler.py` L328-L333](https://github.com/vllm-project/vllm/blob/5df63a7203cdb9328d824a27b682e77c7b9928be/vllm/config/scheduler.py#L328-L333)）。原本每個副本同時生成超過 max_num_batched_tokens 個請求時（例如 DGX Spark 上 1 萬人的不可行情境），指令的 `--max-num-seqs` 會大於 `--max-num-batched-tokens`，無法啟動。決定：計算機**不**為了指令而改用較大的 max_num_batched_tokens（那會讓估算依賴非預設設定，並改變 chunk 大小與排隊）；而是 `--max-num-seqs` 取 min(每副本同時生成數, max_num_batched_tokens)。這不會限制估算的批次：每副本同時生成數超過預算時一定會排隊，同時解碼的最多 D_max ≤ 預算 × 輸出 ÷ (輸出 + 新輸入) ≤ 預算 人（R36），其餘在伺服器的 waiting queue，與模型相同。指令釘住的 `--max-num-batched-tokens` 就是估算所用的值，註解說明上限的原因。多副本時量測的副本固定在 GPU 0…tp−1 與 `--port 8000`，同 node 的其他副本以註解列出各自的 CUDA_VISIBLE_DEVICES 與 port，或改用 `--data-parallel-size`（`docs/research/vllm-tp-kv-precision.md` §7、§8）。
  - 前綴快取與常駐工作階段（2026-10-20 更正，最終審查 I2）：原本所有請求共用一段 `--random-prefix-len` 前綴，閒置的常駐工作階段（研究助理類 N 個中只有 3.3% 在生成）的 KV 從未被留住，量不到記憶體上限。改為快取命中率 > 0 時用 `--dataset-name prefix_repetition`：`--prefix-repetition-prefix-len P`（P = round(輸入 × 命中率)）、`--prefix-repetition-suffix-len 輸入 − P`、`--prefix-repetition-num-prefixes` = 每副本常駐數、`--prefix-repetition-output-len 輸出`，加 `--ignore-eos`（v0.32.0 只對 random 類 dataset 預設 ignore_eos，[`serve.py` L2133-L2139](https://github.com/vllm-project/vllm/blob/5df63a7203cdb9328d824a27b682e77c7b9928be/vllm/benchmarks/serve.py#L2133-L2139)；參數與 dataset 見 [`datasets.py` L1810-L1840](https://github.com/vllm-project/vllm/blob/5df63a7203cdb9328d824a27b682e77c7b9928be/vllm/benchmarks/datasets/datasets.py#L1810-L1840)、[L4181-L4266](https://github.com/vllm-project/vllm/blob/5df63a7203cdb9328d824a27b682e77c7b9928be/vllm/benchmarks/datasets/datasets.py#L4181-L4266)），`--max-concurrency` = 每副本同時生成數，`--num-prompts` = 常駐數 × max(10, …)（每段前綴 num_prompts ÷ 前綴數 個請求）。註解寫明：先以同一指令暖機一次（相同 seed 產生相同前綴）再量測；未重現的部分是閒置工作階段的輸出 token（bench 只留住前綴，研究助理約 96% 的估算上下文），以及記憶體不足時 vLLM 以逐出前綴（命中率下降、TTFT 變長）表現，而不是拒絕。命中率為 0 時維持 random dataset，有閒置常駐時加註「未重現」。
  - Mac 指令（2026-10-20 更正，最終審查 M11、M12）：mlx_lm.server 只能載入 MLX 格式，目錄的 checkpoint（BF16、ModelOpt FP8 等）都不是，所以 `--model` 改為佔位 `"<MLX N-bit checkpoint of …>"`（N = 估算的每參數位元數，AWQ／MXFP4 取 4），註解說明要換成位元數相同的 MLX 量化版本。mlx-lm v0.32.2 的 server 不讀請求的 `ignore_eos`（[`server.py` L1296-L1330](https://github.com/ml-explore/mlx-lm/blob/93e6d4a6447b3080861985947f0820e76fcb957d/mlx_lm/server.py#L1296-L1330)），輸出可能在 EOS 提早結束，註解說明並提供 `--extra-body '{"logit_bias": {"<EOS token id>": -1000}}'` 的作法（logit_bias 為加在 logits 上的偏移，[`sample_utils.py` L111-L116](https://github.com/ml-explore/mlx-lm/blob/93e6d4a6447b3080861985947f0820e76fcb957d/mlx_lm/sample_utils.py#L111-L116)）。另外釘住 server 的預設值（[`server.py` L2025-L2047](https://github.com/ml-explore/mlx-lm/blob/93e6d4a6447b3080861985947f0820e76fcb957d/mlx_lm/server.py#L2025-L2047)）：`--prefill-step-size`（首字時間的分段）一律釘住；每台同時生成超過 32 時加 `--decode-concurrency`（預設最多同時解碼 32 個，估算是全部同時解碼）；有前綴快取且每台常駐超過 10 時加 `--prompt-cache-size`（預設 LRU 只留 10 份 prompt KV）。
  - 原生量化與 `--max-model-len` 餘裕（2026-10-20 補充）：選的量化等於模型的原生格式時不加 `--quantization`／`--dtype`（vLLM 由 config.json 自動偵測），註解說明；選其他格式時沒有可執行的指令，改以 verifyNote 說明需要自行取得 checkpoint（與權重放不下時相同）；MXFP4 只估算原生 checkpoint（`nativeOnly`；2026-10-20 更正：v0.32.0 已有 `--quantization mxfp4` 線上轉換，但其 activation 依 backend 而定、未建模，所以這是計算機的限制，標為 estimate）。`--kv-cache-dtype fp8` 改由 quantization.yaml 的 `vllmServe.kvCacheArgs` 提供。`--max-model-len` = 輸入 + 輸出 + workloads.yaml 的 `benchmark.maxModelLenMarginTokens`（256，estimate），以模型最大上下文為上限：vllm bench 的 prompt 會被伺服器重新斷詞；prompt + max_tokens 超過 max_model_len 時，v0.32.0 會把 max_tokens 截成 max_model_len − prompt（v0.10.0 是拒絕請求；2026-10-20 更正），量到的輸出就會變短（docs/research/prior-art-calculators.md §C）。
- **校正點的條件（2026-10-20，Ruling R41）**：每個點寫明量測時的 `tp`，預測就用那個 tp 的 1 個副本、B = concurrency（封閉迴路，含 R36 排隊），不再用計算機自己選的形狀；validator 拒絕 vLLM 不接受的 tp。`conditions` 記錄引擎版本、啟動參數、環境變數、客戶端、run 連結，以及與計算機模型或驗證指令的所有差異（`deviations`）；長度是均勻抽樣（InferenceX 的 0.8–1.0）時，workload 必須是平均值（floor(0.8 L) 與 L 的平均，±0.5）。fit 點必須在擬合前宣告；derived 值的 `inputs` 可以寫 fit 點的 id，寫 validate 點的 id 會被 validator 拒絕（R30）。
- **NVIDIA H100／H200 校正（2026-10-20，Ruling R41）**：
  - **資料**：SemiAnalysis InferenceX 公開原始結果（2026-10-20 取得；`docs/research/nvidia-calibration-candidates.md`）：gpt-oss-120b（MXFP4）H200 vLLM v0.22.0、H100 v0.21.0，以及 nvidia/Llama-3.3-70B-Instruct-FP8（2026-10-20 匯入，NVIDIA 發表）H100／H200 v0.10.2；共 20 個 run，各取 decode（1 ÷ mean TPOT）與 mean TTFT，40 個點。gpt-oss 的 run 都設了 `VLLM_MXFP4_USE_MARLIN=1`（強制 Marlin MoE kernel，不是預設），記在每個點的 deviations。
  - **fit 點（擬合前宣告）**：H200 TP=1、1k/1k、c=4 的 gpt-oss-120b 與 Llama-3.3-70B-FP8（decode + TTFT）。理由：TP=1 沒有 all-reduce（其延遲本身未定）、c=4 沒有排隊且預填干擾小、1k/1k 的 KV 讀取遠小於權重；同一張 GPU 上一個 MoE MXFP4、一個 dense FP8，才能分開「與模型無關的開銷」和「格式專屬的效率」。其餘 36 點都是 validate。
  - **decode 結構比較**（只用 fit 點擬合，validate 點判斷；18 個 decode validate 點的平均 |誤差|／在 ±25% 內的點數）：(0) 原本（η_bw 0.70、t_fixed 0）76%／5；(a) 每步固定 t_fixed 2.9 ms、η 不變 15%／16；(b) 每層 τ（t_fixed = 層數 × 69 µs）17%／15；(c) η_bw 0.835 + t_fixed 3.6 ms 聯合擬合 19%／16；(c') η_bw + 每層 τ 聯合擬合需要 η_bw 1.34 > 1，不合物理；(d) 只把 MXFP4 專家讀取的效率設為 0.29、t_fixed 0：34%／11（TP=8 高估 +93% 到 +132%，重現不了 TP 增加後的速度下限）。
  - **採用 (a)**：validate 殘差最好、只有一個參數、η 不變，而且有物理意義：vLLM 的 decode 以 CUDA graph 執行，不隨 TP 與模型縮小的是每步的主機端工作（排程、輸入準備、取樣、輸出處理）與 graph 內 kernel 的串行延遲；兩個模型在 TP=8 都停在約 3.7 ms／步，就是這個下限。每層的版本（b）讓 80 層的 Llama 開銷大於 36 層的 gpt-oss，與 TP=8 的資料不符。`tFixedSec` = 0.0029 s（derived，inputs 為兩個 decode fit 點）。gpt-oss 8k/1k 在 c=32、c=64 仍高估 +35%、+65%（validate 警告，原因未明：高 batch 的 MoE kernel 或 prefill 干擾）。
  - **TTFT**：每個請求另加一次 `ttftOverheadSec` = 0.074 s（derived，以兩個 TTFT fit 點擬合，兩點都在 ±2% 內），加在 TTFT、不加在 decode 每步。TTFT validate 的平均 |誤差| 從 66%（18 點中 1 點在 ±25% 內，全部低估）變為 54%（3 點），但 TP ≥ 2 的短 prompt 高估 +22% 到 +111%，8k prompt 仍低估 −13% 到 −54%，高 concurrency 的 mean TTFT 含開頭同時送出的排隊（−57% 到 −85%）。validate 點看起來是「c + k ÷ TP」（c 約 30–40 ms，k 依模型而異的 prefill 效率），兩個 TTFT fit 點無法分辨，留給 issue #10。單一 η_compute（0.18）或依格式的 η_compute（MXFP4 0.09／FP8 0.32）用同樣的 fit 點擬合後，在 8k prompt 與 dense 模型的 TTFT 更差，不採用。η_bw、η_bw,low、η_compute 不變。
  - **適用範圍**：只改 `nvidia-default`（H100／H200，以及同一個設定的 GB200，後者是外推，GB200 沒有 vLLM 實測，issue #11）。MLX 與 DGX Spark 的設定維持 0：fit 點是 NVIDIA HGX 上的 vLLM。
  - **MXFP4 kernel 與驗證指令**：vLLM v0.32.0 在 Hopper 上 gpt-oss 的預設 MoE backend 是 OAI Triton（`--moe-backend auto`），`VLLM_MXFP4_USE_MARLIN` 已移除（v0.22.0 標為 deprecated，對應 `--moe-backend marlin`）；見 `docs/research/vllm-tp-kv-precision.md` §9。採用的 t_fixed 與格式無關（由 dense FP8 與 MXFP4 兩點共同擬合），所以驗證指令維持 v0.32.0 預設 kernel，並在註解寫明校正點是以 Marlin 量測的，要比對時可加 `--moe-backend marlin`。
  - **All-reduce**：TP=2／4／8 的 validate 點與 11 µs 一致（在 ±25% 內）；改用 H100 4-GPU nccl-tests 的 16.1 µs（CUDA graph）或 22.7 µs（eager）會讓這些點系統性低估 −14% 到 −28%，偏向 ≤ 11 µs（vLLM 小訊息在 NVLink 上走自己的 custom all-reduce）。但這些是 validate 點，不能拿來調參（R30），H200 論文數值的 GPU 數也不明，所以維持 11 µs（estimate），列入 issue #10。
  - **缺口**：`nvidia-hgx` 從 gaps 移除（H100、H200 都有點）；`nvidia-gb200` 保留。
  - **影響（全目錄掃描，與 §5.2 相同的 13 個模型 × 原生／FP8 × 3 種負載 × 2 種速度 × 5 種人數 × 8 個平台；新匯入的 Llama-3.3-70B-FP8 另多 480 個結果）**：6240 個結果中 2880 個改變，全部在 `nvidia-default` 的 4 個平台（H100、兩個 H200、GB200 各 720 個；每個結果的首字時間都多了 74 ms 加上每段 prefill 2.9 ms（一段時約 77 ms））；GPU 數增加 432 個、減少 0 個，沒有可行性翻轉，增加最多為 2 倍（例如 phi-4 FP8 對話（流暢）200 人在 H200 從 1 張變 2 張：每步多 2.9 ms 後低於 20 tok/s）。Mac 與 DGX Spark 不變。README 範例（gpt-oss-120b 對話 200 人）的 GPU 數不變，H200 每人速度 29.3 → 27.0 tok/s、首字 0.02 → 0.10 s。
- **國網實測**：國網日後在 nano4 / nano5 的實測數據，以同樣格式加入校正設定，並在結果上標示「已用實測驗證」。

## 6. 硬體與叢集

詳細數字與出處見 [R-HW]、[R-MAC]。設定檔分兩層：

- **硬體（裝置）**：
  - 算力：FP64 / TF32 / BF16 / FP8 / INT8 / FP4，一律存 **dense** 值
  - 記憶體容量與頻寬、NVLink 頻寬、L2、TDP
  - 每個欄位帶出處標記
- **叢集 / 平台**：
  - 節點形狀（每 node 的卡數）、node 數量、NVLink 網域大小
  - 節點間網路（例如 8 × IB NDR 400Gb/s）
  - 排程分區與限制（例如 GB200 工作不跨機櫃）

初始收錄：

| 平台 | 組成 |
|---|---|
| nano5 | H100 SXM 8 卡 / node（21 台）；H200 8 卡 / node（16 台，分區 normal2） |
| nano4 | H200 8 卡 / node（220 台）；GB200 NVL72，4 卡 / node，2 個機櫃共 36 node |
| Mac Studio | M5 Ultra（96 / 256 / 512GB）、M5 Max（36–128GB） |
| Mac mini | M5 Pro（24–64GB）、M6（16–32GB，TB4，不能用 RDMA 串接）。使用者 2026-10-19 指定列為參考依據 |
| DGX Spark | GB10、128GB 統一記憶體、273 GB/s。算力使用實測 MAMF（BF16 99.8、FP8 207.7 TFLOPS），不使用含稀疏加速的「1 PFLOP FP4」標稱值。使用者 2026-10-19 指定列為參考依據；出處見 `docs/research/dgx-spark-mac-mini.md` |
| 參考型號 | HGX B200（目前國網沒有，作為規格參考）；上一代 Mac（M3 Ultra / M4 Max）作為校正資料 |

## 7. 集中化設定

```
config/
  hardware/       每種裝置一檔
  platforms/      國網叢集與 Mac 部署形態
  models/         模型目錄：架構參數（層數、hidden、head、KV head、head_dim、MoE 專家數 / top-k、
                  注意力型別、context 上限）、支援的量化格式、授權
  quantization/   各量化格式的有效位元數與適用平台
  capability/     能力等級、參考模型、評測依據
  workloads/      工作負載類別、領域任務預設、上下文長度、服務目標預設
  demand/         人數漏斗比例
  calibration/    η 區間、固定開銷、多機擴展實測、校正用的實測資料點
  sources/        出處清單（id → 網址、標題、查證日期）
```

- **格式**：YAML，人類可讀、可寫註解（**設計者判斷**）。每個檔案都有 schema（zod）驗證。
- **出處**：每個數值欄位都**必須**附 `status: official | measured | derived | estimate | unverified`、`source: <id>`（`estimate` 要附依據與證據的 id 清單，可附 `judgedBy`（由誰判斷，只用於 estimate）；`derived` 要附公式與輸入的 id）、`verified: <日期>`。規則見第 2.1 節。
- **CI 檢查**：
  - schema 驗證
  - 引用完整性（引用的硬體 / 模型 / 出處必須存在）
  - 單位一致性
  - 校正測試
- **建置**：build 時把設定編譯成一份 JSON bundle，網站與 MCP 共用同一份。
- **版本**：資料有版本號與更新日期，結果頁與 MCP 回應都會標示「資料版本」。
- **新增模型**：可以從 Hugging Face 的 `config.json` 半自動產生 models 條目，再由人工補上量化格式與出處（**設計者判斷**：做成一支 CLI 小工具）。

## 8. 網站體驗

### 8.1 原則

- **漸進揭露**：預設只顯示最少的輸入欄位，其他收進「進階設定」。所有預設值都可以覆寫，覆寫過的欄位要有標示，並能一鍵還原。
- **白話優先**：介面用「人」「每秒字數」「等第一個字幾秒」這類說法，工程術語放在提示框和計算依據裡。
- **一目了然**：結果的第一眼是規模感，例如幾台機器、幾張卡的實體示意，接著才是細節數字。
- **直接操作**：在結果頁可以直接拖拉節點數、人數、上下文長度，即時預覽速度與容量的變化，並保留建議值作為對照。
- **轉換動畫**：在模式之間切換、或參數改變時，用動畫呈現「同一批東西」如何變化，讓使用者追得上因果關係。例如 GPU 方塊重新排列、記憶體區塊堆疊。
- **可稽核**：任何數字都能展開「計算依據」，查看公式、代入值，以及每個值的出處與狀態。

### 8.2 視覺設計準則（使用者指定）

**最高準則：每一個視覺都必須能讓使用者很輕易地找到他想問的那個問題的答案。** 做不到的視覺不放進主畫面。

用以下檢查逐一驗收每個畫面：

1. **一個畫面只回答一個問題。** 畫面最上方用一句白話直接寫出答案，例如「需要 2 台 nano4 H200 node（16 張卡），保守估計 3 台」，視覺是用來佐證這句話。
2. **不看圖例、不讀座標軸也能在約 5 秒內看懂答案。** 主畫面禁用雙 Y 軸、對數刻度，以及需要先讀圖例才懂的編碼。這些只能出現在「專家檢視」。
3. **用使用者的單位，不用工程單位。** 例如用「台機器」「位使用者」「等幾秒才出現第一個字」「打字速度」，不要用 tok/s、TPOT、KV token。工程單位放在提示框與計算依據。
4. **量級要有體感。** 數量用實物單位圖（isotype），例如一台機器一個圖示，讓「2 台」和「12 台」一眼就有差別。跨數量級的比較用「量級尺」，並配上熟悉的參照物。
5. **動畫只用來表達因果。** 同一批物件因為參數改變而變化時才用動畫，例如加人時記憶體裡多出 KV 區塊、需求變大時多出機器圖示。不做裝飾性動畫。
6. **直接操作的結果要立刻看得見。** 拖拉人數或機器數時，答案句、圖示、體驗指標同步更新，並保留建議值作為對照。

### 8.3 問題 → 視覺對應

模式由第 3 節的問題推導而來。下表依 8.2 的準則推導，正式開發前以互動草稿逐一確認。

| 使用者的問題 | 主畫面要給的答案 | 視覺 | 為什麼最直接 |
|---|---|---|---|
| **這個任務是什麼量級？**（從任務入口進來） | 「這類任務需要 T4 等級模型；一個任務約消耗 1 億 token，相當於 10 萬次一般對話」 | **量級尺**：從一般對話到研究規模 Agent，橫跨 10² 到 10⁸，標出這個任務的位置與熟悉的參照物；旁邊是能力等級階梯與參考模型 | 領域專家缺的是對 LLM 量級的直覺。和熟悉的東西比較，比給一個絕對數字更好懂 |
| **要多少？**（正向） | 每個平台一個需求數字與區間 | **實物單位圖**：每個平台一列，一台機器一個圖示（node 或 Mac）。預期值用實心圖示，保守估計多出的部分用虛線圖示。列內附一句白話答案 | 回答的就是「幾台」，數圖示就知道答案，跨平台比較也一眼可見 |
| **撐幾人？多快？**（反向 / 直接操作） | 「這套硬體在每人體驗流暢的前提下最多 N 人；放得下的上限是 M 人」 | **人數滑桿 + 體驗預覽**：用滑桿設定同時人數，畫面上用一段範例文字，以**實際算出的速度逐字出現**，先等 TTFT 那麼久才開始出字。體驗分成流暢 / 可接受 / 卡頓三區，用顏色表示。下方是一張**單軸**的「每人速度 vs. 人數」小圖，標出目前位置與兩個上限 | 「快不快」最直接的回答是讓使用者親眼看到那個速度。單軸小圖只負責交代位置 |
| **為什麼要這麼多？** | 「瓶頸是 KV cache 佔滿記憶體：每多 1 人多佔 1.1 GB」 | **記憶體條**：一根橫條，依序是權重、每人一格的 KV 區塊、剩餘空間。加人時區塊一格格長出來，滿了就變紅。旁邊再一根「每步時間」橫條，分成讀權重、讀 KV、計算、通訊，**最大的那段標成瓶頸** | 用兩根條就能說出「卡在哪」，加人的動畫直接呈現因果 |
| **放得下哪些模型？** | 「這套硬體可以跑以下 K 個模型」 | **排序清單**：每個「模型 × 量化」一列，列內是一根記憶體條（權重加上目標人數的 KV），對照一條容量線。超過的列變灰並沉到下方。每列附能力等級標籤 | 「放不放得下」本質是記憶體條和容量線的比較，清單排序本身就是答案 |
| **哪個平台划算？** | 「以 GPU 數 / 功耗 / 成本計，X 最省」 | **單一指標的排序橫條**：使用者選一個指標，最好的排第一。切換指標時，橫條以動畫重新排序 | 比較題的答案就是排名。一次只看一個指標，避免多維圖表 |

**專家檢視**（預設收合，給國網同仁與進階使用者）：

- 吞吐量 vs. 每人速度的 Pareto 圖
- Roofline 圖，工作點隨 batch 大小移動（呼應 [R-LEC]）
- 雙軸曲線與對數刻度
- 完整的計算依據

**明確淘汰的早期草稿做法**：

- 雙 Y 軸的速度 / 吞吐曲線放在主畫面
- 對數刻度的人數軸放在主畫面
- 只用 tok/s 表達速度

### 8.3.1 主畫面設計 v4（歷史紀錄；版面細節已由 8.3.3 v6 取代）

依據：`docs/research/visualization-design-survey.md`、`docs/research/visualization-exemplars.md`。草稿 v4 已實作並獲使用者肯定。

**決定**：一個畫面、零分頁；一張「每個方案一列」的對齊複合圖；細節在原處展開。這是使用者「一張圖展示全部」與研究結論之間的折衷。研究支持「一個畫面」，但不支持「把所有資訊塞進一個符號」。

畫面由上到下：

1. **答案句兼控制項**（Victor〈Ten Brighter Ideas〉、NYT〈Rent or Buy〉）
   - 句中的人數可以拖拉，負載、模型、速度可以點選。
   - 模型選單裡每個選項都標出 ✓/✗ 與「N/M 方案可行」，用來回答「放得下哪些模型」。
   - 下一行是結論與決策規則，例如「申請時建議以保守數字編列」（Fernandes 2018）。
2. **對齊複合圖**
   - 每個方案一列，依選定的標準排序，排序本身就是比較結果。
   - **排序標準（暫定）**：先以 GPU 總數排序。排序標準寫在設定檔中，可以更換。國網費率確定、成本計算完成後，再由使用者決定是否改為依費用排序（使用者 2026-10-19 指示延後決定）。
   - 每台機器一個圖示（ISOTYPE，Haroz 2015）。圖示高度等於該機的記憶體，**全部用同一比例**（Bycroft 1:1），內部填入權重與 KV。
   - 實心代表預期台數，虛線代表保守估計多出的台數。
   - 右欄是三態判定（PCPartPicker）、白話寫出的原因、每人速度、功耗。
3. **點選某一列，在原處展開**（Transformer Explainer；Shneiderman）
   - 記憶體容量、頻寬、算力三根 0–100% 使用率對齊條，最長的就是瓶頸。
   - 以實際算出的速度逐字出現的範例文字，用來呈現體感。
4. **動畫規則**
   - 只在輸入改變時觸發，每次約 0.4 秒。
   - 同一組物件一起動，不錯開（Chevalier 2014）。
   - 台數改變時留下前一狀態的殘影（Robertson 2008）。
   - 支援 `prefers-reduced-motion`。
5. **專家檢視**（預設收合）：Pareto、Roofline、完整計算依據。

### 8.3.2 自訂能力：模型、工作負載、速度（使用者指定）

目的是讓專業使用者能精確設定。**沒有獨立的「進階模式」**：自訂入口只在預設選項不夠用的地方出現，例如模型搜尋不到、工作選單或速度選單選了「自訂…」、在依據面板中點 ✎（使用者 2026-10-19 指示，入口位置見 8.3.3）。

**A. 模型**

- **從 Hugging Face 匯入**：輸入 repo id，例如 `openai/gpt-oss-120b`，系統讀取模型設定。
  - 已查證：HF API 對任意來源都允許 CORS，純靜態網站可以直接在瀏覽器讀取。
  - 讀取兩個來源：
    - `https://huggingface.co/api/models/<repo>?expand[]=safetensors&expand[]=config&expand[]=sha`：可取得各 dtype 的**實際參數量**，以及 commit sha
    - `https://huggingface.co/<repo>/resolve/<sha>/config.json`：可取得架構參數
  - 2026-10-19 實測：`openai/gpt-oss-120b` 回傳 `safetensors.total = 116829156672`。`config.json` 含 `num_hidden_layers`、`num_key_value_heads`、`head_dim`、`layer_types`（sliding 與 full 交替）、`num_local_experts` 等欄位。兩個請求的回應都帶 `Access-Control-Allow-Origin`。
  - 匯入時，發表者（開發者、國家）由使用者確認，不自動猜測。model card 的 `base_model` 直接記為 `baseModel`（來歷紀錄）。匯入的模型結果附上警告（§9）。
  - **Gated 模型**（例如 `meta-llama/Llama-3.1-8B`）的 config 回傳 401。這種情況下，使用者可以貼上自己的 HF token。token **只存在瀏覽器記憶體中，不寫入儲存、不送往 HF 以外的任何地方**。不提供 token 時，改用手動輸入。
  - 從 config 解析的欄位：
    - 層數、hidden、注意力頭數、KV 頭數、head_dim
    - 注意力型別：
      - GQA / MHA
      - MLA：`kv_lora_rank`、`qk_rope_head_dim`
      - sliding window / 混合層：`sliding_window`、`layer_types`
      - 線性注意力
    - MoE：專家數、`num_experts_per_tok`、專家 FFN 維度，用來推算啟用參數量
    - `quantization_config`：量化方法、bits、group_size，用來換算有效位元數
    - `max_position_embeddings`，以及 rope scaling 延伸後的上限
  - **出處**：匯入的值標為 `official`，出處是 repo 網址加上 commit sha。由 config 推算的值（例如 MoE 啟用參數量）標為 `derived`，並附上算式。
  - **無法解析的架構**：明確告知是哪幾個欄位無法解析，請使用者手動補齊。不猜測。
- **手動自訂模型**：直接填寫上述所有架構參數。

**B. 工作負載**

自訂以下欄位：

- 輸入長度、輸出長度
- context window 上限
- prefix 快取命中率
- 共享的系統提示詞長度
- 每 session 的呼叫次數（Agent 類）
- 人數漏斗比例

所有自訂值都可以從預設帶入後再修改。

**C. 速度目標**

- 自訂 TTFT 上限（秒）與每人 tok/s 下限。
- 自訂百分位（P50 / P95），和第 12 節的餘裕係數一起計算。

**D. 出處與可信度**

- 新增狀態 `user`（使用者自訂）。
- 只要結果用到任何 `user` 值，答案句旁就標示「含自訂輸入」，並在計算依據中列出是哪些值。
- 自訂值跟著網址狀態一起分享，HF token 除外。

**E. MCP**

- `estimate_*` 系列工具接受三種模型參數：模型目錄 id、`hf_repo`（server 端依上述流程讀取），或完整的架構物件。
- 工作負載與速度目標也接受完整自訂物件。

### 8.3.3 主畫面定案 v6（使用者核可版面，2026-10-19）

**來源**：

- 依據 `docs/research/usability-test-v4.md` 的 5 角色模擬測試修改而成。
- 草稿：`docs/prototypes/calculator-demo-v7.html`（Ant Design 版，取代 v6 手寫 CSS 版）。

**設計原則（使用者指定）**：文字越少越好，能用圖就用圖；只直接顯示「做決定必要」的資訊，其他一律點開才出現。**若某項資訊只是在確認「符合你的要求」，就不顯示**。例如：可行就代表速度已達標，不必再列出速度數字。

**第一眼可見**（且只有這些）：

1. **模式切換**：「我需要多少」/「我已有的能撐多少」。
2. **一行完整的填空句**（使用者 2026-10-19 指定的句型）：「同時最多有 `[人數]` 人會使用，做 `[工作 ▾]` 任務，模型用 `[模型（可搜尋）]`，模型精度用 `[量化 ▾]`，希望回應速度 `[速度 ▾]`」。
   - **人數的意思是「同時最多人數」，不是總人數**，因此主流程不經過 4.3 節的人數漏斗。漏斗保留為輔助工具：使用者只知道總人數時，可以在依據面板中換算。
   - 「同時」的解讀依工作類型而定，寫在依據面板中，可以修改：
     - 對話類：N 人同時在等回覆（最保守的上限，`estimate`）。
     - 研究助理類：N 個工作階段同時開著、上下文保留在記憶體；同時在生成的比例取 TraceLab 實測的 3.3%（`derived`）。
   - 人數可以直接打字。
   - 「我已有」模式下，開頭改為「我有 `[數量]` 個 `[平台 ▾]`，…」。
   - **必須保留完整的句子**，不能縮減成以「·」分隔的欄位。使用者 2026-10-19 指出，縮減後「沒人知道這是幹嘛」；v4 測試中句子式也是最受肯定的設計。
3. **一行答案**：
   - 我需要多少：`GB200 × 1　nano4 · 4 GPU`，下面一行小字 `保守 × 1`。
   - 我已有：`同時 624 人`，下面一行小字 `保守 …`。
   - 答案旁邊放一個「推估」標記（使用者自訂時再加「自訂」標記），以及「ⓘ 依據」「⧉ 引用」兩個按鈕。
4. **每個平台一列**（順序固定，「自建」類以分隔線區隔）：
   - 名稱
   - 機器圖示（實心為預期，虛線為保守估計多出的台數）
   - 大字顯示台數
   - **容量條**：以「同時人數」為單位，例如 `同時 8 / 45 個工作階段`，顯示目前負載佔上限的比例。
   - 不可行的方案只寫一句原因，例如 `✗ 首字要等 38 秒`。
   - 最佳方案的那一列加上左側色條。

**點開才出現**：

- **點某一列**：
  - 打字示範（先等待首字延遲的時間，再以算出的速度逐字出現，內容依工作類型而定）
  - 四根使用率條：記憶體、頻寬、算力、首字，最滿的那根標紅
  - 記憶體組成條
  - 功耗
- **ⓘ 依據**：
  - 所有假設與出處的編號清單，附狀態標籤
  - 最上方是可修改的「尖峰人數 / 每次讀入與回覆長度 / 速度定義」
- **模型選單**：
  - 建議的模型等級（推估）
  - 每個模型可在幾種機台上執行
  - 從 Hugging Face 搜尋或匯入、手動輸入架構
- **工作 / 速度選單最後一項「自訂…」**：在原處展開欄位。這就是「需要時才出現」的進階入口，**沒有獨立的進階模式**。
- **⧉ 引用**：產生可以貼進申請書的段落，附參考來源清單。

**說明一律用 Popover / Tooltip 呈現（使用者 2026-10-19 指示）**：

- 下拉選單的每個選項都附一行說明。桌面上滑鼠移過或用鍵盤移到該選項時顯示；觸控裝置（`hover: none`）上直接顯示在選項名稱下方。說明中的數字必須來自已有出處的設定值，不做未查證的品質斷言。
- 其他需要解釋的元素也一樣用 popover：「推估」標記、不可行原因、容量條、使用率條、機器圖示。**觸發方式要同時支援 hover、點擊／觸控與鍵盤焦點**。v4 測試發現，只靠 hover 的說明在手機上完全看不到。
- 預設畫面不放解釋文字。解釋按需出現，不佔版面。

**以「同時人數」作為主要顯示單位（使用者 2026-10-19 核可）**：

- 物理計算可靠的量是「同時人數 / 工作階段數」。由總人數換算而來的「約相當於 N 名使用者」依賴推估的人數漏斗，數字可能大到失真（測試中出現過「351 萬人」），因此**不放在主畫面**，只在依據面板中列出。
- 輸入端改為讓使用者填「同時最多人數」（使用者 2026-10-19 決定）。只知道總人數的人，在依據面板中使用漏斗換算。

**視覺樣式**：

- 目前草稿是手寫 CSS，**正式版改用 UI 元件庫精修**（使用者 2026-10-19 指示）。具體選用哪一套由實作計畫決定。
- 需求：
  - 支援 React
  - 可存取性良好
  - 支援深色模式
  - 能和 D3 圖表並存
  - 不帶過重的預設視覺風格
- **採用 Ant Design**（使用者 2026-10-19 建議）。demo 已用 antd 5.29.3 + React 18.3.1 重建並驗證（`docs/prototypes/calculator-demo-v7.html`）。
- 正式版的版本**不可憑印象假設**：實作時要查 npm registry，選擇發布至少兩週的穩定版。2026-10-19 查得的最新版是 antd 6.6.x、React 19.3.x（React 19 已不提供 UMD，需走打包流程），並依官方 v6 遷移文件確認 API 差異。
- **demo 已知缺陷，正式版必修**（使用者 2026-10-19 回報）：某個選單的選取狀態會被其他選單的操作刷新。正式版的要求：
  - 所有輸入一律做成受控元件，狀態集中管理（單一 state store 或 URL state）。
  - 元件不可在每次 render 時重新建立定義：demo 把子元件與 `sel()` 定義在主元件內部，這是可疑原因。
  - 要寫元件測試：依序操作每個選單後，其他選單的值必須保持不變。
- 已知 AntD 行為要注意：
  - Progress 到 100% 時會自動顯示為成功（綠色），需要固定 `status="normal"`。
  - 兩個字的中文按鈕會被自動插入空格。

### 8.4 技術

- **框架**：Vite + React + TypeScript（**設計者判斷**：React 只負責表單與版面）。
- **圖表與動畫**：一律用 **D3**，搭配 d3-transition。
- **語言**：繁中 / 英文切換；文案集中在語系檔。設定檔中的白話描述也要有雙語欄位。
- **部署**：純靜態網站，所有計算在瀏覽器內完成。
- **分享與匯出**：輸入狀態編碼到網址，方便分享（**設計者判斷**）。可匯出 PDF / Markdown 摘要，供申請書使用（**設計者判斷**）。
- **成本**：國網的計費費率不在研究範圍內。費率欄位放在設定檔中，有填才顯示新台幣金額；沒填則只顯示 GPU 小時與功耗（**設計者判斷**）。

## 9. MCP 介面

- **共用核心**：與網站共用 `core` 套件與設定 bundle。
- **傳輸方式**：同時提供 stdio（本機）與 Streamable HTTP（遠端）。

工具（tool）初步清單：

| tool | 用途 |
|---|---|
| `list_platforms` / `list_models` / `list_workloads` / `list_capability_tiers` | 列出可用選項與說明，讓 Agent 能把使用者的白話描述對應到預設 |
| `estimate_requirements` | 正向推算：負載 → 各平台所需 node / GPU 與區間 |
| `estimate_capacity` | 反向推算：硬體配置 → 最大人數、速度曲線資料點 |
| `find_feasible_models` | 硬體加服務目標 → 可行的「模型 × 量化」組合 |
| `explain` | 回傳某次計算的完整計算依據（公式、代入值、出處） |

回應一律是結構化 JSON，包含以下欄位：

- 數值與單位
- 區間
- 瓶頸類型
- 假設清單
- 出處 id
- 資料版本
- 驗證指令

設計上要讓 Agent 能直接轉述給使用者，也能據此做下一步判斷。

**錯誤契約**（2026-10-20 補充，審查 M-2）：呼叫者的輸入有問題時，`core` 一律丟出 `CoreInputError`，以 `code` 區分：

- `invalid-input`：不符合輸入 schema；`issues` 列出每一項（zod issue），原始 ZodError 放在 `cause`。
- `unknown-id`：設定 bundle 中沒有這個模型、量化、平台、負載或速度標準 id。

`hfRepo` 不是 `owner/name` 時是 `invalid-input`。

**警告**：不阻擋的提醒放在結果的 `warnings: { code, text }[]`，不是錯誤。目前只有 `custom-model-supply-chain`：每個使用者自訂模型的 `estimateRequirements`、`estimateCapacity`、`explain` 結果都附上，驗證指令的第一行也以 `# ` 註解寫出同一段文字；目錄模型沒有。text 為「國網中心規定禁止使用紅色供應鏈模型（發表者為中國、香港或澳門組織）。使用後果請用戶自行承擔。」

其他錯誤（一般 `Error`）代表設定或核心本身的問題，不是使用者能修正的輸入。

輸入路徑（2026-10-20 補充，最終審查 M16）：`estimate_capacity` 不接受 `users`（人數是它的答案；原本收下後默默忽略）；`explain` 依輸入決定路徑：給 `platform` 就是容量路徑，必須同時給 `gpus`、不得給 `users`；否則是需求路徑，必須給 `users`。兩種錯誤各有明確的訊息（`invalid-input`）。

## 10. 架構

```
config/                   ← 集中設定（第 7 節）
packages/
  schema/                 ← zod schema 與型別
  core/                   ← 純計算，不依賴 DOM 或 Node；輸入設定 bundle 與查詢，輸出結果與計算依據
  data/                   ← 建置腳本：驗證 config/ 並產生 bundle
apps/
  web/                    ← 靜態網站
  mcp/                    ← MCP server（stdio + HTTP）
docs/research/            ← 研究筆記（資料出處的來源）
```

- 單一 repo，用 pnpm workspace 管理（**設計者判斷**）；測試用 Vitest。
- `core` 必須 100% 可單元測試。網站與 MCP 都不得自行實作公式。

## 10.1 補充決定（審稿後，皆為**設計者判斷**）

- **推論引擎**
  - 每個平台有預設引擎：NVIDIA 用 vLLM，Mac 用 MLX。
  - 進階設定可以切換：NVIDIA 可選 vLLM / SGLang，Mac 可選 MLX / llama.cpp。
  - 引擎影響三件事：校正係數、固定開銷、驗證指令。
  - 自動求解時不搜尋引擎，只用目前選定的引擎。
- **初始資料**
  - 由實作者依 `docs/research/` 填入，每筆都附出處與狀態。
  - 標為 `unverified` 或 `derived` 的值，例如 GB200 每 node 4 卡、Mac TFLOPS、NVLink / IB 延遲，**允許上線**。但介面上必須明確標示，且出現在結果的假設清單中。
  - 模型目錄的初始範圍：`docs/research/open-models.md` 中的最新開源模型，約 20–30 個。
- **校正資料的用途**
  - 每個資料點標記為「擬合用」或「驗證用」，兩者分開，避免同一組數據既拿來調參又拿來驗證。
  - CI 規則：
    - schema、引用完整性、單位錯誤：**擋下**
    - 驗證用資料點的誤差：只**警告**，並把結果寫進準確度頁
  - 初始容忍度：decode tok/s ±25%、記憶體 / 最大並發 ±10%。之後依實際資料調整。
- **MCP**
  - 所有工具都是**無狀態**的。`explain` 收到相同輸入後重新計算並回傳計算依據，不依賴伺服器保存的計算 ID。
  - 遠端 HTTP 端點只提供計算，不涉及敏感資料。預設不需要驗證，但支援用設定開啟 token 驗證與速率限制。
- **講義檔案**：[R-LEC] 講義在 `reference/`，這個資料夾被 `.gitignore` 排除，不在 repo 中。本文第 5.2 節已寫出需要的 Roofline 概念，實作者不需要讀講義。

## 10.2 使用者決定（2026-10-19）

- **配置單位是「張 GPU」，不是整個 node。** 國網可以只申請一個 node 中的部分 GPU（使用者確認）。
  - 求解在每個平台上，於合法配置中找出 **GPU 總數最少**、同時滿足記憶體與服務目標的配置。
  - 合法配置是：每個副本使用 t 張 GPU，t ∈ {1, 2, 4, 8} 且不超過每 node 卡數，在同一 node 內做張量平行；副本數量不限。
  - 實作時要再確認：張量平行數必須能整除注意力頭數與 KV 頭數；推論引擎是否還有其他限制。
  - Mac 仍以「台」為單位。
  - 結果顯示為「H200 × 4 張」。展開後顯示「每副本 2 張 × 2 個副本」。總數達到或超過一個 node 時，附註相當於幾個 node。
  - demo 驗證：研究助理、15 人、Llama 3.3 70B FP8 → H200 需 4 張（2 副本 × 2 張）、H100 需 8 張、GB200 需 4 張。
- **第一版優先順序由實作者安排**（使用者表示沒有差別）。採用的順序：
  1. 計算核心與集中設定（含 schema、出處檢查、golden tests、校正測試）
  2. 網站主畫面（8.3.3 v6 版面，Ant Design）
  3. MCP（stdio 與 HTTP）
  4. 自訂能力（Hugging Face 匯入、自訂模型 / 工作 / 速度）
  5. 引用文字匯出與專家檢視
- 沒有指定期限。

## 11. 留給實作者決定的部分

- 元件切分、狀態管理、樣式方案。
- schema 的具體欄位命名，前提是滿足第 7 節的出處要求。
- 自動選平行化配置時的搜尋策略：窮舉合法形狀即可，空間很小。
- 動畫的具體時長與緩動曲線。
- 遠端 MCP 的主機與部署方式：由國網提供環境，實作者提供 Dockerfile 即可。

## 12. 已知風險與待補資料

- **延遲數據不足**：NVLink / IB 延遲沒有官方數據，目前用實測或第三方值 [R-HW]。好在 decode 的通訊成本在大訊息時由頻寬主導，延遲影響較小。
- **GB200 的部分規格是推算值**：每 node 4 卡、每 node 的 HCA 數，需要向國網系統組確認 [R-HW]。
- **Mac 的部分數據缺漏**：多人並發的實測資料幾乎不存在 [R-USER]。M5 Max / Ultra 的 70B 實測也還缺 [R-MAC]。
- **繁中能力缺乏 2026 年評測**：能力等級裡的繁中建議需要國網自行實測 [R-TASK]。
- **百分位數是近似值**：分析式模型給的是平均值。vLLM 每步 token 上限造成的排隊以 Little's law 的流體近似計入平均 TTFT（Ruling R36，§5.2），沒有突發，是平均等待的下限。P95 / P99 **目前沒有估算**（2026-10-21 更正，最終審查 M29：原本寫「透過設定檔的餘裕係數近似」，但沒有這個係數，也沒有實作）；尾端餘裕留到 Plan 5，與 `concurrency.queueRule` 的依據一致（W 是平均等待的下限），屆時再決定用餘裕係數或接 Vidur 類模擬器校正（**設計者判斷**）。
