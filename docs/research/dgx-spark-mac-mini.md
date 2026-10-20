# DGX Spark 與 Mac mini 規格查證筆記

- **查證日期**：2026-10-19
- **用途**：作為計算機的參考平台（自建選項），與國網機台並列比較。
- **原則**：每個數字都附出處；推算值與推估值都另外標明。

## NVIDIA DGX Spark（GB10）

| 項目 | 數值 | 狀態 | 出處 |
|---|---|---|---|
| 晶片 | NVIDIA GB10 Grace Blackwell Superchip；CPU 為 20 核 Arm（10× Cortex-X925 + 10× Cortex-A725） | official | [NVIDIA DGX Spark](https://www.nvidia.com/en-us/products/workstations/dgx-spark/) |
| 統一記憶體 | 128 GB LPDDR5x（64 GB 版本僅由 OEM 夥伴販售，標示「Coming Soon」）；256-bit 介面 | official | 同上 |
| 記憶體頻寬 | **273 GB/s** | official（規格值，非實測） | 同上；[StorageReview](https://www.storagereview.com/review/nvidia-dgx-spark-review-the-ai-appliance-bringing-datacenter-capabilities-to-desktops) |
| AI 算力（官方） | 「up to 1 petaFLOP FP4」，**含稀疏加速**（StorageReview 引用的規格表寫「(with Sparsity)」）；NVIDIA 產品頁未註明 | official | 同上 |
| **BF16 實測矩陣乘法** | **99.8 TFLOPS**（mamf-finder，MAMF） | measured | StorageReview |
| **FP8（E4M3）實測矩陣乘法** | **207.7 TFLOPS**（mamf-finder） | measured | StorageReview |
| FP4 dense | 約 400 TFLOPS（StorageReview 自行外推，**非實測**） | unverified | StorageReview |
| 網路 | ConnectX-7 200 Gbps，加上 10 GbE；官方表示最多可串接 4 台 | official | NVIDIA |
| 功耗 | GB10 TDP 140 W；電源供應器 240 W | official | NVIDIA |
| 價格 | 官網未列 | — | NVIDIA |

### 實測推論吞吐（StorageReview，每秒輸出 token 數）

| 模型 | 精度 | 同時 1 個請求 | 高並發 |
|---|---|---|---|
| Llama 3.1 8B | BF16 | 13.6 | 408.6（128） |
| Llama 3.1 8B | FP8 | 23.2 | 752.8（128） |
| Llama 3.1 8B | FP4 | 34.1 | 924.1（128） |
| Qwen3 Coder 30B-A3B | FP8 | 46.5 | 482.6（batch 64） |
| Qwen3 Coder 30B-A3B | BF16 | 27.8 | 166.2（batch 64） |
| Mistral Small 3.1 24B | BF16 / FP8 | 5.3 / 8.8 | 158.9 / 319.7（128） |
| GPT-OSS 20B / 120B | NVFP4 | 39.7 / 31.4 | 611.7（128）/ 162.7（64） |

其他實測：

- gpt-oss-120b（MXFP4）用 llama.cpp 生成速度為 60.6 tok/s；32K context 時為 40.6 tok/s（[llama.cpp #16578](https://github.com/ggml-org/llama.cpp/discussions/16578)）。
- 相關討論見 [Enverge 分析](https://spark.enverge.ai/blog/dgx-spark-prefill-vs-decode)、[SiliconBench](https://arxiv.org/pdf/2609.19169)。

### 推算的頻寬效率（DERIVED）

- 以 Llama 3.1 8B FP8、同時 1 個請求為例：23.2 tok/s × 約 8.03 GB 權重 ≈ 186 GB/s，除以 273 ≈ **0.68**。
- 這個算法忽略了 KV 讀取，所以效率略為低估。
- 推論引擎：文章把這組測試標為「vLLM Online Serving」，所以引擎是 vLLM；但沒有寫 vLLM 版本或啟動參數，這兩項標記為 UNVERIFIED。（本條於 2026-10-19 更正。原本寫「未明確交代引擎」，與文章內容不符。）

**StorageReview 測試條件查證**（added 2026-10-19, verified；[StorageReview DGX Spark review](https://www.storagereview.com/review/nvidia-dgx-spark-review-the-ai-appliance-bringing-datacenter-capabilities-to-desktops)）：

- **有寫的**：
  - 測試名稱是「vLLM Online Serving」，文中稱 vLLM 是「the most popular high-throughput inference and serving engine for LLMs」。
  - 每個模型各自寫了同時請求數：Llama 3.1 8B（BF16、FP8、FP4）、Mistral Small 3.1 24B（BF16、FP8）、GPT-OSS 20B 為 1 與 128；Qwen3 Coder 30B-A3B FP8 為 1 與 batch 64；GPT-OSS 120B 為 1 與 64。
  - 「The output throughput is the throughput across requests and not per request throughput」。
- **沒有寫的**：
  - vLLM 版本與啟動參數。
  - 上表各模型結果的輸入／輸出長度。文中只有另一組 prefill／decode 測試寫了長度（prefill-heavy 8,192 輸入、512 輸出；decode-heavy 512 輸入、8,192 輸出），而且沒說那組測試用哪個模型。
- 因此計算機的校正報告不能用這些點：不知道輸入／輸出長度，就無法用相同條件預測。這些點只列入 `config/calibration.yaml` 的 `skipped`（Ruling R28）。

### 計算機的採用方式

- 算力用**實測的 MAMF 值**（FP8 207.7、BF16 99.8），**不用** 1 PFLOP 這個含稀疏加速的 FP4 標稱值。
- 頻寬用 273 GB/s 搭配推算的效率 0.68。
- 多台串接（ConnectX-7）不在第一版計算範圍。

## Mac mini（目前機型；來源見 `apple-silicon.md`）

| 機型 | 記憶體 | 頻寬 | 有效算力（推算） | 串接 |
|---|---|---|---|---|
| Mac mini M5 Pro 18C/20G | 48 / 64 GB | 307 GB/s（Apple 未另列，沿用 15C/16G 機型的數值） | 約 21.8 TFLOPS（由 llama.cpp pp512 推算） | TB5，可用 RDMA |
| Mac mini M6 | 16 / 24 / 32 GB | 170 GB/s（24/32GB）；153 GB/s（16GB） | 約 13.3 TFLOPS（推算） | TB4，**不可用 RDMA** |

- Apple 沒有公布 TDP 或功耗，計算機中標為未查證（`null`）。
- 頻寬效率：沒有 Mac mini 專屬的實測，比照 Mac Studio 的 MLX 推算值，標為推估。
