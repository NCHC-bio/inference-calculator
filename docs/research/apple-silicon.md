# Apple Silicon（Mac Studio / Mac mini）推論機規格查證筆記

- 查證日期：2026-10-19
- 用途：推論算力計算機的 Apple 機台資料來源
- 原則：每個數字都附來源。Apple 未公開、由實測或推算得出的數字標 **DERIVED**；未查證的標 **UNVERIFIED**

## 重點結論

1. **產品線已換代**：2026-08-25 發表，2026-09-22 出貨。
   - 目前的 Mac Studio：**M5 Max 或 M5 Ultra**
   - 目前的 Mac mini：**M6 或 M5 Pro**
   - M3 Ultra、M4 Max、M4 Pro 都已經是上一代
2. **Apple 沒有公開 GPU TFLOPS，也沒有公開 Neural Engine TOPS**。計算機裡的算力數字全部是推算或實測值，必須如此標示。
3. **多機串接**需要 **Thunderbolt 5 加上 macOS 26.2 以上**，透過 RDMA over TB5 搭配 MLX JACCL backend。M6 Mac mini 只有 TB4，**不能用 RDMA 串接**。
4. **多機擴展效果**：
   - Tensor parallel：decode 速度 2 台約 1.7–1.8 倍，4 台約 2.6–3.0 倍
   - Pipeline parallel：decode 幾乎不會變快（約 1.0 倍），只能拿來擴充容量

來源：[Studio specs](https://www.apple.com/mac-studio/specs/)、[mini specs](https://www.apple.com/mac-mini/specs/)、[Studio newsroom](https://www.apple.com/newsroom/2026/08/apple-introduces-new-mac-studio-with-m5-max-and-m5-ultra/)、[M6/M5 Ultra newsroom](https://www.apple.com/newsroom/2026/08/apple-introduces-m6-and-m5-ultra-for-a-big-leap-in-performance-and-ai-compute/)、[mini newsroom](https://www.apple.com/newsroom/2026/08/apple-unveils-a-more-powerful-mac-mini-featuring-the-all-new-m6-and-m5-pro/)、[US Studio store](https://www.apple.com/shop/buy-mac/mac-studio)、[US mini store](https://www.apple.com/shop/buy-mac/mac-mini)、[TW Studio store](https://www.apple.com/tw/shop/buy-mac/mac-studio)、[TW mini store](https://www.apple.com/tw/shop/buy-mac/mac-mini)

## 1. 目前在售機型（Apple 官方數字）

| 機型 / 晶片 | CPU | GPU | 記憶體選項 | 記憶體頻寬 | TB 連接埠 | 網路 | 起價（USD / TWD） |
|---|---|---|---|---|---|---|---|
| Studio M5 Max 18C/32G | 18 | 32 | 僅 36GB | 460 GB/s | 背面 4 個 TB5 | 10GbE | $2,499 / NT$84,900 |
| Studio M5 Max 18C/40G | 18 | 40 | 48 / 64 / 128GB | 614 GB/s | 背面 4 個 TB5 | 10GbE | $3,099 / NT$105,900 |
| Studio M5 Ultra 30C/64G | 30 | 64 | 僅 96GB | 1.2 TB/s | 共 6 個 TB5 | 10GbE | $5,499 / NT$199,900 |
| Studio M5 Ultra 36C/80G | 36 | 80 | 96 / 256 / 512GB（512GB「10 月底推出」） | 1.2 TB/s | 共 6 個 TB5 | 10GbE | $6,799 / NT$245,400 |
| mini M6 | 12 | 12 | 16 / 24 / 32GB | 153 GB/s（16GB）、170 GB/s（24/32GB） | 3 個 **TB4**（不支援 RDMA） | 2.5GbE，可選 10GbE | $899 / NT$29,900 |
| mini M5 Pro 15C/16G | 15 | 16 | 24GB | 307 GB/s | 3 個 TB5 | 2.5GbE，可選 10GbE | $1,699 / NT$59,900 |
| mini M5 Pro 18C/20G | 18 | 20 | 48 / 64GB | 307 GB/s（Apple 未另列，沿用上一行） | 3 個 TB5 | 2.5GbE，可選 10GbE | $1,899 / NT$66,900 |

表格註記：

- **價格**：上表為起價。M5 Ultra 的選配加價出自 [Tom's Hardware review](https://www.tomshardware.com/desktops/mini-pcs/apple-mac-studio-m5-ultra-review)：
  - 30C/64G 升到 36C/80G：加 $1,300
  - 96GB 升到 256GB：加 $4,000
  - 實測機（36C/80G、256GB、4TB）售價 $12,299，交期 16–18 週
- **Apple 官方宣稱**：
  - M5 Ultra 的 UltraFusion 晶片間頻寬「over 4.4TB/s」
  - M5 Ultra 記憶體頻寬比 M3 Ultra 高 50%
  - 4 台 Mac Studio 組成的叢集，AI 推論「最高快 3 倍」
- **上一代（用於校正）**：M3 Ultra 819 GB/s；M4 Max 410 GB/s（32G 版）或 546 GB/s（40G 版）

## 2. GPU 算力（全部 DERIVED，Apple 未公開）

| 晶片 | FP32 SIMD | FP16 矩陣（GPU Neural Accelerators） | 實測有效 prefill 算力 |
|---|---|---|---|
| M6 12G | UNVERIFIED | UNVERIFIED | 約 13.3 TFLOPS |
| M5 Pro 20G | 8.3 | 約 33 | 約 21.8 |
| M5 Max 40G | 17–18 | 約 65–70 | 約 43.4 |
| M5 Ultra 80G | 33 | 約 131 | 約 66.6 |
| M3 Ultra 80G（上一代） | 無來源 | 無 Neural Accelerators | 約 19.8 |
| M4 Max 40G（上一代） | 無來源 | 無 Neural Accelerators | 約 11.9 |

推算方式：

- **FP32 SIMD** = 核心數 × 128 ALU × 2 × 時脈。基本款 M5 實測 3.81 / 4.04 TFLOPS，達成率 94%（[michaelstinkerings](https://www.michaelstinkerings.org/apple-m5-gpu-roofline-analysis/)、[flopper](https://flopper.io/gpu/apple-m5-ultra)）。
- **FP16 矩陣** = 每核心每週期約 1024 FLOPs × 核心數 × 約 1.6 GHz（[tzakharko](https://tzakharko.github.io/apple-neural-accelerators-benchmark/)）。M5 Pro/Max/Ultra 的時脈為 UNVERIFIED。
- **實測有效 prefill 算力** = llama.cpp pp512 tok/s × 2 × 6.74B（Llama-2-7B Q4_0）。
- **交叉核對**：Apple MLX 文章裡 M5 Ultra prefill 8K token 的結果，換算約 108 TFLOPS 有效算力，與推算的 131 TFLOPS 峰值相符。
- Creative Strategies 報導的 M5 Max「19.9 TFLOPS」指的是 Neural Engine，不是 GPU。

## 3. 多機串接：RDMA over Thunderbolt 5

**使用條件**（[Apple TN3205](https://developer.apple.com/documentation/technotes/tn3205-low-latency-communication-with-rdma-over-thunderbolt)）：

- macOS 26.2 以上，Apple silicon 機型需有 TB5
- 從 Recovery 模式執行 `rdma_ctl enable`，並關閉 Thunderbolt Bridge
- 只支援點對點連線，沒有路由功能。full mesh 延遲最低；ring 拓樸需由應用程式自行轉送資料
- 文件記載可以 5 台組成 ring。Jeff Geerling 先前回報上限是 4 台

**MLX JACCL backend**（[MLX docs](https://ml-explore.github.io/mlx/build/html/usage/distributed.html)）：需 MLX v0.30.1 以上，只支援 full mesh。

**連線實測**：

| 指標 | 數值 | 來源 |
|---|---|---|
| TB5 標稱速度 | 80 Gb/s 對稱；Apple 規格頁寫「up to 120Gb/s」，指非對稱模式 | Apple 規格頁 |
| iperf3，單條 TB5 線 | 單向約 47 Gbit/s，雙向約 80 Gbit/s | [avlp12/two-macstudio-m3u](https://github.com/avlp12/two-macstudio-m3u) |
| all_sum @ 512 MB，單線 | JACCL RDMA 9.31 GB/s；ring TCP 4.5–5.1 GB/s | avlp12 |
| all_sum @ 512 MB，三條線 | jaccl-ring 15.46 GB/s；TCP 9.6 GB/s | avlp12 |
| 小訊息延遲 | JACCL **21.2 µs @ 8KB**；ring TCP 163.6 µs @ 4KB | avlp12（macOS 26.5.2、MLX 0.32.0） |
| 延遲改善 | 「300μs 降到 50μs 以下」 | [Jeff Geerling](https://www.jeffgeerling.com/blog/2025/15-tb-vram-on-mac-studio-rdma-over-thunderbolt-5/) |
| 3–9 µs 的延遲說法 | UNVERIFIED，只有部落格宣稱 | — |

**穩定性問題**（avlp12）：`kill -9` 後會發生 wired memory 洩漏，偶爾也會遇到 collective 操作卡住。

**Apple MLX 官方擴展測試**（[Apple ML Research, 2026-10-15](https://machinelearning.apple.com/research/mlx-distributed-inference)）：

- 測試條件：M5 Ultra 512GB；每條連線用 2 條 TB5；生成 128 token
- 表格數值為 decode tok/s，括號內為 TTFT（第一個 token 的等待時間）

| 模型 | M3 Ultra | M5 Ultra | 2 台 pipeline | 2 台 tensor | 4 台 tensor |
|---|---|---|---|---|---|
| Qwen 3.8 27B BF16 @ 8K | 12.46（18.2s） | 19.69（4.1s） | 19.44 | 33.27 | 50.89（1.7s） |
| Qwen 27B @ 64K | 11.54（199.4s） | 17.87（43.7s） | 18.04 | 30.84 | 47.45（15.6s） |
| Mistral Medium 3.5 128B FP8 @ 8K | 4.95（95.9s） | 7.70（24.6s） | 7.70 | 13.69 | 23.37（7.5s） |
| Mistral 128B @ 64K | 3.88（1,097.9s） | 6.16（273.0s） | 6.14 | 11.05 | 18.92（80.0s） |
| Muse Spark Open 816B-A42B NVFP4 @ 8K | — | — | 15.74 | 24.99 | 36.73 |
| Muse Spark Open @ 64K | — | — | 14.37 | 23.84 | 34.66 |

- 峰值功耗：M3 Ultra 約 200W，M5 Ultra 約 300W
- 4 台 M3 Ultra 跑 exo 的實測：Qwen3 235B 32 tok/s，Kimi K2 Thinking 約 30 tok/s（Geerling）

## 4. Decode 效率校正

效率 = 實際使用頻寬 ÷ 標稱頻寬，其中實際使用頻寬 = decode tok/s × 權重大小。這個算法忽略了 KV cache 讀取，所以效率略為低估。

| 晶片 | 執行環境 / 模型 | Decode tok/s | Prefill tok/s | 效率 | 來源 |
|---|---|---|---|---|---|
| M3 Ultra | llama.cpp、Llama 3.1 70B Q4_K_M | 14.08 | 151–160 | **73%** | [geerlingguy/ai-benchmarks#42](https://github.com/geerlingguy/ai-benchmarks/issues/42) |
| M3 Ultra | llama.cpp、Llama 405B Q4_K_M | 1.96 | 13.74 | **58%** | 同上 |
| M3 Ultra | MLX、Qwen 27B BF16 @ 8K | 12.46 | 約 450 | **約 82%** | Apple ML |
| M3 Ultra | MLX、Mistral 128B FP8 @ 8K | 4.95 | 約 85 | **約 77%** | Apple ML |
| M5 Ultra | MLX、Qwen 27B BF16 @ 8K | 19.69 | 約 1,998 | **約 89%** | Apple ML |
| M5 Ultra | MLX、Mistral 128B FP8 @ 8K | 7.70 | 約 333 | **約 82%** | Apple ML |

**小模型測試**（[llama.cpp discussion #4167](https://github.com/ggml-org/llama.cpp/discussions/4167)，Llama-2-7B Q4_0，單位 tok/s）：

| 晶片 | pp512 | tg128 |
|---|---|---|
| M3 Ultra | 1471 | 92.1 |
| M4 Max | 886 | 83.1 |
| M4 Pro | 440 | 50.7 |
| M5 Pro | 1621 | 66.3 |
| M5 Max | 3220 | 119.9 |
| M5 Ultra | 4945 | 179.1 |
| M6 | 989 | 35.7 |

M6 那一列的 GPU 核心數和頻寬，與 Apple 官方規格不一致。小模型跑不滿大晶片，效率校正應該以 27B 以上的模型為準。

M5 Max 和 M5 Ultra 目前沒有可信的 70B Q4 實測。彙整網站上的 20–30 tok/s 屬於估計值，UNVERIFIED。

**建議的計算機預設值（DERIVED）**：

- **Decode 效率**：
  - MLX 跑大型 dense 模型：0.75–0.85
  - llama.cpp Q4_K_M：0.70–0.75
  - 超大模型（例如 405B）：約 0.55–0.6
- **Prefill**：用上面第 2 節的「實測有效 prefill 算力」，不要用峰值
- **多機 tensor parallel 的 decode 加速倍數**：2 台 1.7 倍，4 台 2.6–3.0 倍

**GPU 可用記憶體上限**（added 2026-10-19, verified）：

- Apple **沒有公布** macOS 預設的 GPU wired-memory 上限（Metal `recommendedMaxWorkingSetSize`）佔統一記憶體的比例。
- 唯一找到的「75%」出自 [Apple Developer Forums thread 732035](https://developer.apple.com/forums/thread/732035)。說這句話的是一位使用者（Tantamount，2023-11），不是 Apple 工程師：「I believe Apple has a hard coded limit of 75% of physical memory.」
- [Mac LLM Calculator](https://github.com/bagdaer1/mac-llm-calculator) 的 README 沒有寫任何比例，只說「macOS wants roughly 3 GB」。
- 第三方指南多寫「約 2/3 到 3/4」，也沒有官方出處。可用 `sudo sysctl iogpu.wired_limit_mb=<MB>` 調高（Sonoma 14 以上）。
- 計算機的 `mac-mlx.memUtil = 0.75` 因此標為 estimate。

**KV cache dtype（MLX）**（added 2026-10-19, verified）：

- mlx-lm 的 `KVCache.update_and_fetch` 以傳入 keys／values 的 dtype 建立快取（`mx.zeros(k_shape, keys.dtype)`），也就是模型的激活 dtype；MLX 模型的激活一般是 fp16 或 bf16，每個元素 2 bytes。權重量化（4／8 bit、FP8 checkpoint 轉檔）不會改變 KV cache 的 dtype。出處：[mlx-lm v0.32.2 `mlx_lm/models/cache.py` L339–356](https://github.com/ml-explore/mlx-lm/blob/v0.32.2/mlx_lm/models/cache.py#L339-L356)。
- KV 的配置單位（2026-10-20 補查）：`KVCache.step = 256`；`update_and_fetch` 放不下新 token 時以 `ceil(新 token 數 / 256) × 256` 擴充（快取長度不是 256 的倍數時先截到目前長度再接上），所以 full 層與 MLA 持有 ceil(上下文 / 256) × 256 個 token。sliding window 層的 `RotatingKVCache` 以同樣的 step 成長，到 `max_size`（window）為止，之後原地輪替，穩態正好是 window 個 token（多 token 的 prefill 時暫時最多 max_size + S − 1）。出處：[mlx-lm v0.32.2 `mlx_lm/models/cache.py` L339–366](https://github.com/ml-explore/mlx-lm/blob/v0.32.2/mlx_lm/models/cache.py#L339-L366)、[L423–520](https://github.com/ml-explore/mlx-lm/blob/v0.32.2/mlx_lm/models/cache.py#L423-L520)。
- prefill 分段（2026-10-20 補查）：`mlx_lm.server` 的 `--prefill-step-size` 預設 2048（[server.py L2036–2041](https://github.com/ml-explore/mlx-lm/blob/v0.32.2/mlx_lm/server.py#L2036-L2041)，傳給 BatchGenerator，L916、L1110）。BatchGenerator 每次取 `min(prefill_step_size, 剩餘)` 個 prompt token 做一次 `self.model(...)` 並 `mx.eval`（[generate.py L1112、L1219–1231、L1871–1879](https://github.com/ml-explore/mlx-lm/blob/v0.32.2/mlx_lm/generate.py#L1219-L1231)），單一請求的 `generate_step` 也是 2048（L323、L437–452）。所以 MLX 的 prefill 也是逐段 forward，每段重讀一次權重；段大小固定，不受 decode 負載影響（vLLM 則是每步預算扣掉 decode 後的剩餘）。
- `mlx_lm.server` 的 `--kv-bits` 預設 `None`（說明文字：「Default: None (full precision)」），也就是預設不量化 KV cache；指定後會停用 batching。出處：[mlx-lm v0.32.2 `mlx_lm/server.py` L2054–2060](https://github.com/ml-explore/mlx-lm/blob/v0.32.2/mlx_lm/server.py#L2054-L2060)。
- 因此 Mac（MLX）平台的 KV cache 一律以 2 bytes／元素計算（`mac-mlx.kvBytesPerElemOverride = 2`，derived），不跟著量化格式的 `kvBytesPerElem`（vLLM 的 FP8 KV cache 是 1 byte）。

## 5. 供貨注意事項

- 2026 年稍早，Apple 曾因缺貨把上一代 Studio 的記憶體上限降到 96GB（[Tom's Hardware](https://www.tomshardware.com/desktops/apple-quietly-axes-128gb-mac-studio-amid-supply-constraints-and-local-ai-frenzy-highest-memory-capacity-reduced-to-96gb-two-months-after-discontinuation-of-512gb-model)）。
- M5 Ultra 512GB 版本目前尚未出貨。
