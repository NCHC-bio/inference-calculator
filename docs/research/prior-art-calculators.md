# 現有 LLM 推論計算機盤點：它們算什麼、使用者怎麼評價

- 查證日期：2026-10-19
- 方法：WebSearch、WebFetch、GitHub issues、Hacker News（Algolia API）
- **限制**：Reddit 無法存取，所以沒有 Reddit 證據。標 *(unverified)* 的項目來自二手來源，或頁面只能用 JavaScript 呈現、無法直接讀取。

## A. 工具清單（24 個）

### 消費者 / 本機「放不放得下」類

| # | 工具 | 回答的問題 | 輸入 | 輸出與呈現方式 | 缺點、抱怨 |
|---|---|---|---|---|---|
| 1 | [HF Accelerate estimate-memory](https://huggingface.co/docs/accelerate/usage_guides/model_size_estimator) | 權重佔多少記憶體 | Hub 模型 ID、資料型別 | 各 dtype 一張文字表 | 文件自己說「not to perform inference」，推論要再加最多 20% |
| 2 | [Vokturz Can You Run It](https://huggingface.co/spaces/Vokturz/can-it-run-llm) | 需要幾張 GPU X | 模型、GPU 廠牌與型號、LoRA % | Plotly 長條圖；綠/黃/紅代表 1 / 2 / 3 張以上 | 只算權重 × 1.2，沒有 KV cache、上下文、同時人數 |
| 3 | [ApX VRAM calculator](https://apxml.com/tools/vram-calculator) | 放不放得下、速度、成本 | 模型、權重量化、KV 量化、GPU、batch、序列長度、同時人數（1–8）；「Advanced」收合 | VRAM 儀表、生成速度、TTFT、租金、模擬面板；有 Recommend / Optimize / 分享網址 | 有[公開準確度頁](https://apxml.com/tools/vram-calculator/accuracy)：VRAM 誤差中位數 0.9–3.5%，速度誤差約 14–24%（unverified） |
| 4 | [gpu_poor](https://github.com/RahulSChand/gpu_poor) | 記憶體、tok/s、最大 context 與 batch | 模型、量化、序列長度、batch、框架、GPU | 記憶體分項、tok/s、記憶體或算力受限判定 | issue #1「不可靠」；#9 batch 不影響推論記憶體（作者說只考慮 batch=1）；#11「magic numbers 是什麼」 |
| 5 | [HF Hub 硬體相容面板](https://huggingface.co/docs/hub/main/hardware.md) | 這個 repo 的哪個量化放得下我的硬體 | 硬體一次存進個人檔案 | 每個量化旁標示放不放得下 | 使用當下零輸入，HN 評價最高；只支援 GGUF / MLX |
| 6 | [NyxKrage GGUF VRAM](https://huggingface.co/spaces/NyxKrage/LLM-Model-VRAM-Calculator) | 權重加上 context 記憶體 | 模型、量化、context | — | 自己說「不會 100% 準確」；context 記憶體被質疑異常偏大 |
| 7 | [Modular LLM Inference Handbook](https://handbook.modular.com/) | 教學解說 | — | GPU 記憶體、KV cache、量化、延遲指標、時間軸等互動小工具 | 公式為 P × Q/8 × (1 + 10–30%)，並警告「KV cache can dominate」 |
| 8 | [Incoherency VRAM & context](https://tools.incoherency.co.uk/post/llm-vram-and-context-calculator-launched) | **從硬體反推容量** | 架構參數、同時 session 數、GPU 數 | 指定同時人數下的最大 context；指定 context 下的最大同時人數 | 批評其他工具「one headline number and not much else」 |
| 9 | [Slopsome / Will It Fit](https://slopsome.com) | 放得下嗎、多快 | 模型、GPU、量化、context | 四種判定（放得下 / 需卸載 / 需多卡 / 放不下），並附**實測 tok/s 資料庫** | 使用者要求支援多 GPU |
| 10 | [Mac LLM Calculator](https://github.com/bagdaer1/mac-llm-calculator) | Apple Silicon 放不放得下、tok/s | Mac 機型、模型 | 公式：s/token = GB ÷ (BW × 0.9075) + 0.00325；dense 模型誤差 4–4.5% | MoE 只算啟用權重會高估，作者自加 1.3 倍修正；不算 prefill 和 batch |
| 11 | [Martin Alderson speed calc](https://martinalderson.com/posts/local-llm-speed-calculator/) | 買之前先估 tok/s | 三層記憶體、dense 或 MoE、量化、context | 頻寬 ÷ 每 token 讀取量 | 自稱是「樂觀上限」，實際只達 60–90% |
| 12 | [asmirnov VRAM Estimator](https://vram.asmirnov.xyz/) | 解說記憶體去哪了 | 完整架構參數 | 分項清單，每項附**一行理由** | CUDA overhead 範圍從 300 MiB 到 2 GiB |
| 13 | [inference.ai calculator](https://calculator.inference.ai/) | 需要多少 GPU | 11 個欄位 | — | [HN](https://hn.algolia.com/api/v1/items/44676961) 評價很差：「absolutely meaningless」、預設 FP32、不支援多卡切分 |
| 14 | 其他 | — | — | — | smcleod、deadjoe、linpp2009、dwojcik、BenchLM、Kolosal、Vercel LLM Inference Calculator（作者自稱 ±30%，HN 使用者要求**反向模式**）、SelfHostLLM |

### 推論引擎內建的 sizing

**15. vLLM / SGLang 啟動 log 與 Anyscale 調校指南**

- vLLM 啟動時會印出「Maximum concurrency for N tokens per request」（[討論串](https://discuss.vllm.ai/t/some-questions-about-maximum-concurrency/1145)）。
- SGLang 會印出 `max_total_num_tokens`。
- Anyscale 建議把 `max_num_seqs` 設得比這個硬上限低 20–50%（[文件](https://docs.anyscale.com/llm/serving/parameter-tuning)）。
- **啟示**：「到底能放幾個人」的實際答案來自推論引擎自己的量測，計算機只是在逼近它。

### 企業 / 資料中心 sizing

**16. [Lenovo LLM Sizing Tool v2.0](https://lenovopress.lenovo.com/lp2487-lenovo-llm-sizing-tool)**

- 方向：從使用情境和人數推算硬體。
- 輸入：
  - 情境預設（chatbot、RAG、agent、code）一鍵帶入全部參數；選 Custom 才打開進階欄位。
  - 每位使用者每分鐘請求數、HA（N+1 備援）、NVLink 開關。
- 輸出：GPU 數、VRAM 圓餅圖、伺服器配置、功耗、TTFT、ITL、最大同時人數、PDF 匯出。

**17. [NVIDIA AIConfigurator](https://github.com/ai-dynamo/aiconfigurator)**

- 給定 TTFT / TPOT 的服務目標，找出最佳的 TP/PP 配置，以及 aggregated 或 disaggregated 部署。
- 輸出 **tokens/s/GPU 對 tokens/s/user 的 Pareto 圖**。
- 支援範圍有限，自己承認在高吞吐區偏樂觀；目前只維護、不再開發。

**18. NVIDIA GenAI-Perf / NIM benchmarking / TCO 部落格**

- 做法是實測：先量一個部署單位的表現，再依尖峰負載放大。
- 文中強調「同時請求數不等於同時在線使用者數」（[部落格](https://developer.nvidia.com/blog/llm-inference-benchmarking-how-much-does-your-llm-inference-cost)）。
- 實例：4×H100 上，同時 1 個請求時 TTFT 約 1.3 秒，同時 100 個請求時約 85 秒（[文件](https://docs.omniverse.nvidia.com/services/latest/services/usd-code/performance.html)）。

**19. [Azure PTU calculator](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/provisioned-throughput-sizing)**

- 輸入：尖峰每分鐘呼叫數、prompt 與回應長度、**快取命中率**。
- 輸出 token 的權重是輸入 token 的 4–8 倍。

**20. [SemiAnalysis InferenceX](https://inferencex.semianalysis.com/glossary/throughput)**

- 用每晚實測的數據，畫出「每 GPU 吞吐量」對「每人互動速度」的 **Pareto 前緣**，並換算每百萬 token 成本。
- 重點：只看峰值吞吐量會誤導判斷。

**21. [Artificial Analysis](https://artificialanalysis.ai/leaderboards/hosts)**

- 雲端 API 的速度、價格、TTFT 實測散佈圖。
- 可以當作「買 API 還是自建」的參考。

### 學術 / 模擬工具

**22. [LLM-Viewer](https://github.com/hahnyuan/LLM-Viewer)（Roofline）**

- 逐層顯示 OPs、記憶體存取量、算術強度、受限類型；有可點擊的網路圖。
- issue #4：預測值和 TRT-LLM 實測差距很大；還有多個公式錯誤的 issue 沒關。

**23. [Vidur / Vidur-Search](https://github.com/microsoft/vidur)**

- 用實測過的運算子效能做離散事件模擬，延遲誤差小於 9%。
- 能找出滿足服務目標、成本最低的配置。
- 限制：不支援 MoE，context 長度上限 4K–16K。

**24. LLMCompass、LLM-Inference-Bench**

- 學術用的硬體評估工具：[LLMCompass](https://arxiv.org/abs/2312.03134)、[LLM-Inference-Bench](https://arxiv.org/abs/2411.00136)。

**沒找到的**：AWS 和 GCP 的 LLM GPU 容量規劃工具；Baseten、Modal、Together、Databricks 的計算機（Databricks 只有[指南文章](https://www.databricks.com/blog/llm-inference-performance-engineering-best-practices)）。

## B. 綜合分析

### (1) 使用者帶著哪些問題來，依提供該功能的工具數排序

| # | 問題 | 方向 | 工具數 |
|---|---|---|---|
| 1 | **模型 X（量化 Q、context C）放得進 GPU Y 嗎？** | 模型 + 硬體 → 放不放得下 | 約 20 |
| 2 | **在硬體 Y 上多快（tok/s、TTFT）？** | 硬體 → 速度 | 約 11（另有 3 個實測型） |
| 3 | **N 個使用者 / 在服務目標內，需要幾張 GPU、能撐多少同時人數？** | 任務 → 硬體 | 約 9 |
| 4 | **成本：每百萬 token、租金、TCO、API 和自建比較** | 任務 → 成本 | 約 7 |
| 5 | **用什麼部署配置（TP/PP、P/D 分離）？** | 任務 + 硬體 → 配置 | 3 |
| 6 | **我的硬體能跑哪些模型 / 量化？** | 硬體 → 模型 | 約 3 |
| 7 | **我的硬體最大 context / 最多 session 是多少？** | 硬體 → 容量 | 約 3 |
| 8 | **解釋記憶體和時間花在哪** | 解說 | 3 |

### (2) 沒有工具做好的缺口

1. **從總使用者數推到同時在線人數，再推到請求速率**：沒有工具建模使用者的思考時間、每人請求頻率、尖峰。Lenovo 的「每人每分鐘請求數」最接近。
2. **在瀏覽器裡、任意硬體上，看「吞吐量 vs 延遲」的服務目標權衡**：只有 CLI 工具做得到，而且支援範圍窄。
3. **「從硬體反推容量」作為主要模式**：HN 上有人明確要求。
4. **Prefill / TTFT 建模**：多數工具不算。
5. **MoE、MLA 等新架構**：多半靠經驗係數硬湊。
6. **Prefix caching 與快取命中率**：只有 Azure 和 AIConfigurator 有。
7. **多節點、互連、共享 HPC 叢集（排程單位、節點形狀、排隊）**：完全沒有工具處理，而這正是國網的情境。
8. **非 NVIDIA 硬體、多模態模型**。
9. **公開驗證誤差**：只有少數工具公布。

### (3) 常見的準確度陷阱

- **只算權重，或固定加一個比例的 overhead**（×1.2、+10–30%）。
- **沒算 KV cache，或沒考慮 GQA**。例如 Llama-3.1-8B 在 H100 上，4K context 可以服務約 107 人，128K 只剩約 3 人（[Spheron](https://www.spheron.network/blog/how-many-concurrent-users-can-one-h100-serve-a-kv-cache-sizi/)）。
- **沒考慮 batch 和同時人數**（gpu_poor #9）。
- **activation 和 prefill 的工作記憶體**：vLLM 的 `max_num_batched_tokens` 會壓縮 KV pool（unverified）。
- **框架與 CUDA overhead**：各來源估 150 MiB 到 2 GiB 不等。
- **量化檔案的實際大小不等於 bits × 參數量**：Q4_K_M 約 4.9 bits/weight。
- **執行環境的功能會改變結果**，例如 Flash Attention。
- **Roofline 給的是上限不是預測**：實際只達上限的 60–90%；Databricks 量到不同雲端的同規格機器延遲差 2 倍。
- **把 prefill 和 decode 混為一談**：一個 tok/s 數字無法同時描述兩者。
- **加 GPU 不會讓延遲等比例下降**：Llama2-70B 從 4 卡加到 8 卡，延遲只降到 0.7 倍。
- **使用者普遍不信任通用計算機**：HN 上有人說「網路上大概 10 個計算機，沒有一個能用」。

### (4) 對國網設計的啟示（從上述證據推論）

- **值得借鏡的做法**：
  - 情境預設一鍵帶入，Custom 才展開進階欄位（Lenovo）
  - 放不放得下的判定，加上記憶體分項圖（Lenovo、ApX）
  - 從硬體反推最大 context / 最大同時人數（Incoherency）
  - 每 GPU 吞吐量對每人速度的 Pareto 圖（AIConfigurator、InferenceX）
  - 公開準確度頁（ApX）
  - 用推論引擎回報的 KV 容量做校正（vLLM、SGLang）
- **最大的空白**：把使用者數和請求率轉成「符合服務目標的 GPU 數 / 節點數」，而且要放在共享叢集的情境下，並支援 MoE、MLA、prefix caching。

## C. 設定檔補充出處（量化位元數、vLLM 預設值）

以下出處供 `config/quantization.yaml` 與 `config/calibration.yaml` 使用，原本不在研究筆記中，於實作時逐一以 WebFetch 查證。

| 出處 id | 網址 | 查證到的內容 | 備註 |
|---|---|---|---|
| `vllm-optimization-docs` | https://github.com/vllm-project/vllm/blob/5df63a7203cdb9328d824a27b682e77c7b9928be/vllm/engine/arg_utils.py#L952-L967 | vLLM v0.32.0 `vllm/engine/arg_utils.py` 註冊 `--dtype`（L952）、`--max-model-len`（L966）、`--quantization`／`-q`（L967）、`--tensor-parallel-size`（L1177）、`--gpu-memory-utilization`（L1356-L1361）、`--kv-cache-dtype`（L1365）；`vllm/config/model.py` `ModelDType = Literal["auto", "half", "float16", "bfloat16", "float", "float32"]`（L99）；`max_model_len`「Model context length (prompt and output). If unspecified, will be automatically derived from the model config.」（L245-L257）。`gpu_memory_utilization` 預設 0.92（`vllm-v032-cache-config`） | (added 2026-10-19；2026-10-20 改釘 v0.32.0 原始碼並重新查證)。原本引用 v0.10.0 文件 https://docs.vllm.ai/en/v0.10.0/configuration/engine_args.html（`--gpu-memory-utilization`「Default: 0.9」），屬歷史紀錄。驗證指令：bf16 用 `--dtype bfloat16`；`--max-model-len` = 估算用的輸入 + 輸出 + 餘裕；`--gpu-memory-utilization` 固定為校正設定的 memUtil |
| `vllm-quantized-kv-cache` | https://github.com/vllm-project/vllm/blob/5df63a7203cdb9328d824a27b682e77c7b9928be/docs/features/quantization/quantized_kvcache.md#L20-L50 | vLLM v0.32.0「Quantized KV Cache」：`kv_cache_dtype="fp8"` 把 KV cache 量化為 FP8（L20-L29），`auto`「Use the model's default data type」（L37-L39），CLI `--kv-cache-dtype fp8`（L50） | (added 2026-10-19；2026-10-20 由 latest 文件改釘 v0.32.0)。頁面沒有直接寫「每元素 1 byte」，由 FP8 為 8 位元推得 |
| `arxiv-2209.05433` | https://arxiv.org/abs/2209.05433 | Micikevicius et al.,「FP8 Formats for Deep Learning」：8-bit 浮點交換格式 E4M3 / E5M2 | (added 2026-10-19, verified) |
| `google-bfloat16` | https://docs.cloud.google.com/tpu/docs/bfloat16 | Google Cloud TPU「Improve your model's performance with bfloat16」：「bfloat16 uses half of the memory space」（相對於 float32） | (added 2026-10-19, verified)。舊網址 cloud.google.com/tpu/docs/bfloat16 會 301 轉到此處 |
| `arxiv-2306.00978` | https://arxiv.org/abs/2306.00978 | Lin et al.,「AWQ: Activation-aware Weight Quantization for LLM Compression and Acceleration」：4-bit weight-only 量化；§5.1「We used a group size of 128 throughout the work, except otherwise specified.」 | (added 2026-10-19, verified)。group128 的 INT4 有效位元數 (4 + 32/128) = 4.25 bits 為推算（每組一個 16-bit scale 與一個 16-bit zero）。vLLM 實際把 zero 以 4-bit 打包（見 `vllm-awq-linear`），實際約 4.156 bits ≈ 0.52 bytes；4.25 bits 為保守上限（2026-10-19 補充，Ruling R12） |
| `vllm-fp8-docs` | https://github.com/vllm-project/vllm/blob/5df63a7203cdb9328d824a27b682e77c7b9928be/docs/features/quantization/online.md#L1-L51 | vLLM v0.32.0「Online Quantization」：「take a BF16/FP16 model and quantize its Linear and MoE weights to lower precision (such as FP8) at load time … activations are dynamically scaled during each forward pass」（L3-L6）；CLI `vllm serve … --quantization fp8_per_tensor`（L38）；fp8_per_tensor = fp8_e4m3 權重與 activation、per-tensor scale（L51） | (added 2026-10-19；2026-10-20 改釘 v0.32.0)。**行為更動**：v0.10.0 文件（fp8.md「Online Dynamic Quantization」，`--quantization="fp8"`）在 v0.32.0 已移除；`--quantization fp8` 仍可用，但線上量化時印「--quantization fp8 is deprecated for online quantization; use --quantization fp8_per_tensor instead」並轉成 fp8_per_tensor（`vllm/model_executor/model_loader/weight_utils.py` L351-L357）。驗證指令 fp8 因此改用 `--quantization fp8_per_tensor`。checkpoint 已宣告另一種 `quant_method` 時，`ModelConfig._verify_quantization` 丟「does not match」（`vllm/config/model.py` L1443-L1448），例如 gpt-oss 的 MXFP4 checkpoint |
| `vllm-awq-docs` | https://github.com/vllm-project/vllm/blob/5df63a7203cdb9328d824a27b682e77c7b9928be/docs/features/quantization/auto_awq.md#L46-L53 | vLLM v0.32.0「AutoAWQ」頁：AWQ checkpoint 需先離線量化（AutoAWQ 已棄用，改由 llm-compressor），以 `--model TheBloke/Llama-2-7b-Chat-AWQ --quantization auto_awq` 執行（L46-L53） | (added 2026-10-19；2026-10-20 改釘 v0.32.0)。`awq`、`awq_marlin`、`auto_awq` 在 v0.32.0 都對應同一個 `AutoAWQConfig`（`quantization/__init__.py` L157-L159），驗證指令維持 `--quantization awq`。vLLM 沒有線上轉 AWQ 的路徑，所以驗證指令用 `<AWQ checkpoint of {hfRepo}>` 佔位並附說明。**行為更動**：v0.10.0 `awq_marlin.py` 在使用者明確指定 `awq` 時「forcing awq」不用 Marlin；v0.32.0 已合併為 `auto_awq.py`，CUDA 上支援時一律用 Marlin kernel（見 `vllm-awq-marlin`） |
| `vllm-awq-linear` | https://github.com/vllm-project/vllm/blob/5df63a7203cdb9328d824a27b682e77c7b9928be/vllm/model_executor/layers/quantization/auto_awq.py#L797-L876 | vLLM v0.32.0 `AutoAWQConfig.__init__`：`self.pack_factor = 32 // weight_bits`（L196；4 bits → 8）；`BaseAWQLinearMethod.create_weights`：`qweight` 與 `qzeros` 都是 `torch.int32`，輸出維度為 `output_size_per_partition // pack_factor`（`qzeros` 為 `num_groups × output/8`，即每個 zero 4 bits），`scales` 為 `num_groups × output`、dtype = `params_dtype`（16-bit）（L797-L876） | (added 2026-10-19；2026-10-20 改釘 v0.32.0，v0.10.0 的 `awq.py` 已併入 `auto_awq.py`，打包方式不變)。Ruling R12：每組 128 個權重實際為 4×128 + 16（scale）+ 4（zero）= 532 bits → 4.156 bits/參數 → 約 0.5195 bytes；設定檔的 0.53125（zero 以 16 bits 計）為上限估計，保留 status estimate |
| `vllm-optimization-docs`（引擎參數，驗證指令用） | （同上一列，2026-10-20 合併） | 見上方 `vllm-optimization-docs` 列（v0.32.0 `arg_utils.py`） | 原本此列記錄 v0.10.0 的同一組旗標，屬歷史紀錄 |
| `ocp-mx-spec` | https://www.opencompute.org/documents/ocp-microscaling-formats-mx-v1-0-spec-final-pdf | OCP Microscaling Formats (MX) Specification v1.0（2023-09）§5.1：「each block of k elements can be encoded in (w + kd) bits」；表 1（§5.2）：MXFP4 = 元素 FP4 (E2M1)、d = 4、k = 32、scale E8M0、w = 8 | (added 2026-10-20, verified)。MXFP4 每參數 = (8 + 32 × 4) / 32 / 8 = 0.53125 bytes（`quantization.mxfp4.bytesPerParam`，status derived）。PDF 有加密但可抽出文字（pypdf，空密碼） |
| `vllm-mxfp4-src` | https://github.com/vllm-project/vllm/blob/5df63a7203cdb9328d824a27b682e77c7b9928be/vllm/model_executor/layers/quantization/mxfp4.py#L78-L113 | vLLM v0.32.0：`Mxfp4Config.get_supported_act_dtypes` 回傳 `[torch.bfloat16]`（L78-L80）；`get_quant_method` 對一般 `LinearBase` 回傳 `UnquantizedLinearMethod`（debug log「MXFP4 linear layer is not implemented - falling back to UnquantizedLinearMethod」，L91-L113），只有 `RoutedExperts` 走 MXFP4；`Mxfp4MoEMethod.create_weights` 以 `torch.uint8` 建立打包權重與 scale（L659-L670）；gpt-oss checkpoint 走 `GptOssMxfp4Config`，MoE backend 優先序在每個系列中 BF16 activation 的變體在前（`fused_moe/oracle/mxfp4.py` L389-L422） | (added 2026-10-20，原釘 v0.10.1；2026-10-20 改釘 v0.32.0)。所以 `mxfp4.computeDtype = bf16`（gpt-oss 預設路徑）。**行為更動**：v0.10.1 的一般 Linear 層會 `NotImplementedError`、沒有線上 MXFP4；v0.32.0 有 `--quantization mxfp4` 線上轉換（`vllm/config/quantization.py` L192-L235，`vllm-v032-online-quant`），其 MoE backend 在 SM100 以上優先 FP4／MXFP8 activation（`oracle/mxfp4.py` L425-L448）。計算機沒有建模這條路徑，所以 `vllmServe.nativeOnly` 改為計算機自己的限制（status estimate）。v0.10.1 是第一個含 mxfp4 的 tag（`vllm-mxfp4-v0101`，歷史），所以原生 checkpoint 仍需 vLLM ≥ 0.10.1。未建模：Blackwell 補齊後 gpt-oss（2880 → 3072）的專家權重在 GPU 記憶體中最多約為 checkpoint 的 (3072/2880)² ≈ 1.14 倍 |
| `vllm-gpt-oss-recipe` | https://github.com/vllm-project/recipes/blob/c033a835ef28b28a857f199ac43044dd4cf06077/OpenAI/GPT-OSS.md | vLLM Recipes「GPT-OSS」：快速開始以 `vllm serve openai/gpt-oss-120b`（可加 `--tensor-parallel-size`）啟動，不加量化參數；`GPT-OSS_Hopper.yaml` 不設 `kv-cache-dtype`，`GPT-OSS_Blackwell.yaml` 設 `kv-cache-dtype: fp8` 並以 `VLLM_USE_FLASHINFER_MOE_MXFP4_MXFP8=1`「Use FlashInfer MXFP4+MXFP8 MoE」 | (added 2026-10-20, verified)。釘在 recipes repo commit c033a83（2026-05-10，該檔最後修改）。估算採預設路徑（BF16 activation、`--kv-cache-dtype auto` = 2 bytes）；Blackwell 的 MXFP8 / FP8 KV 最佳化屬選用設定，未建模 |
| `vllm-config-quant-detect` | https://github.com/vllm-project/vllm/blob/5df63a7203cdb9328d824a27b682e77c7b9928be/vllm/config/model.py#L1370-L1448 | vLLM v0.32.0 `ModelConfig._verify_quantization`：取 checkpoint 的 `quantization_config`（L1376），`if self.quantization is None: self.quantization = quant_method`（L1440-L1442），否則不一致時丟「does not match」（L1443-L1448） | (added 2026-10-20，原釘 v0.10.0 `vllm/config.py` L999-L1075；2026-10-20 改釘 v0.32.0，行為相同)。原生量化 checkpoint 的驗證指令因此不加 `--quantization`／`--dtype` |
| `vllm-awq-marlin` | https://github.com/vllm-project/vllm/blob/5df63a7203cdb9328d824a27b682e77c7b9928be/vllm/model_executor/layers/quantization/auto_awq.py#L262-L335 | vLLM v0.32.0 `AutoAWQConfig.override_quantization_method`：`quant_method` 為 awq 的 checkpoint，使用者指定 `awq`／`awq_marlin`／`auto_awq`／`marlin` 都改為 `auto_awq`（L262-L286）；`get_quant_method` 在 CUDA 上 `check_marlin_supported` 時用 `AutoAWQMarlinLinearMethod`，否則 `AutoAWQLinearMethod`（Triton）（L288-L335） | (added 2026-10-20，原釘 v0.10.0 `awq_marlin.py` L107-L123)。**行為更動**：v0.10.0 明確指定 `awq` 時「… so forcing awq. Use quantization=awq_marlin for faster inference」；v0.32.0 已沒有 `awq_marlin.py`，指定 `awq` 也會用 Marlin。int4-awq 的 `vllmServe.note` 已依此改寫 |
| `vllm-bench-random-dataset` | https://github.com/vllm-project/vllm/blob/5df63a7203cdb9328d824a27b682e77c7b9928be/vllm/benchmarks/datasets/datasets.py#L494-L547 | vLLM v0.32.0 `RandomDataset`：`real_input_len = input_len - num_special`（L599-L600）；`generate_token_sequence` 的 prompt 為 prefix + input_len 個 token（`total_input_len = prefix_len + int(input_len)`，L753），以 `gen_prompt_decode_to_target_len` 解碼後再編碼，長度不符時最多重試 10 次（補隨機 token 或截斷），仍不符才回報 mismatch（L494-L547）。`--random-range-ratio` 預設 0.0（L1899-L1904），`--seed` 預設 0（L1585）。預設 backend `openai`（`serve.py` L1600-L1605）以 `/v1/completions`（L1616-L1620）送 `"max_tokens": output_len`（`lib/endpoint_request_func.py` L212） | (added 2026-10-20，原釘 v0.10.0 `vllm/benchmarks/datasets.py` L326-L392；2026-10-20 改釘 v0.32.0)。**行為更動**：v0.10.0 只截斷一次（`tokenizer.encode(prompt)[:total_input_len]`），v0.32.0 會重試讓重新編碼後的長度相符，所以客戶端漂移更小。伺服器端仍會再斷詞一次（completions 預設 `add_special_tokens=True`，`openai/completion/protocol.py` L117-L123） |
| `vllm-serving-validate-input` | https://github.com/vllm-project/vllm/blob/5df63a7203cdb9328d824a27b682e77c7b9928be/vllm/entrypoints/serve/utils/api_utils.py#L169-L205 | vLLM v0.32.0 `get_max_tokens`：prompt 長度超過 `max_model_len` 時丟「Input length … exceeds model's maximum context length」（L183-L187），否則 `max_tokens` = min(max_model_len − prompt 長度, 請求的 max_tokens, …)（L188-L205）；completions 以它決定 max_tokens（`openai/completion/serving.py` L157-L164） | (added 2026-10-20，原釘 v0.10.0 `serving_engine.py` L576-L635)。**行為更動**：v0.10.0 `OpenAIServing._validate_input` 在 `token_num + max_tokens > max_model_len` 時拒絕請求（L625-631）；v0.32.0 不再拒絕，而是把 max_tokens 截短。所以 `--max-model-len` 的餘裕在 v0.32.0 是避免輸出被截短（量到的不是指定的輸出長度），不是避免被拒絕 |
| `bench-retokenize-drift`（本專案量測） | （本節） | 以 v0.10.0 `RandomDataset.sample` 的相同流程（截斷一次、不重試；seed 0、range ratio 0；歷史量測，v0.32.0 的重試只會讓漂移更小），計算伺服器端 `len(tokenizer.encode(prompt, add_special_tokens=True)) − (prefix + input)`。tokenizer（HF `AutoTokenizer`，2026-10-20 下載）：microsoft/phi-4、openai/gpt-oss-120b、mistralai/Mistral-Small-3.1-24B-Instruct-2503、allenai/OLMo-2-0325-32B、ibm-granite/granite-3.3-8b-instruct、mistralai/Mistral-Small-4-119B-2603。長度組合：無前綴 1020 / 4096 / 8192 / 12035（各 100、100、50、100 筆，6 個 tokenizer）；有前綴 510+510 / 6000+6035 / 100000+26180（各 100、50、10 筆，前 4 個 tokenizer 中的 phi-4、gpt-oss、Mistral Small 3.1、Granite） | (added 2026-10-20, verified)。**結果：所有組合的最大漂移都是 0（沒有任何 prompt 比指定長度長）**；最短少 187 token（gpt-oss，輸入 1020）。依據原始碼，變長方向仍可能發生（decode → encode 不保證可逆），所以 `workloads.yaml` `benchmark.maxModelLenMarginTokens` = 256（status estimate：取觀測到的漂移量級 187 向上取整，作為未觀測到的變長方向的保險）。餘裕只加長 `--max-model-len`，不影響 KV pool（由 `--gpu-memory-utilization` 決定）；以模型的 maxContext 為上限 |
