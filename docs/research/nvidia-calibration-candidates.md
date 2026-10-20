# NVIDIA H100／H200／GB200 公開實測：校正與驗證候選點

- **調查日期**：2026-10-20（所有網址的取得日期都是這一天，下文不再逐一標註）
- **用途**：替 `config/calibration.yaml` 的 `nvidia-hgx`、`nvidia-gb200` 兩個缺口（GitHub issue #10、#11）找公開實測。§1–§6 是調查時的建議（不修改 config）；實際採用的內容見 §7（2026-10-20，Ruling R41）。
- **規則**（`calibration.yaml` 開頭、Ruling R28／R30）：
  - 每個數字附出處，條件不齊的不用，也不自行推斷缺少的條件。
  - 不為了讓點吻合去調 η。`fit` 點是用來設定 η 的，`validate` 點是獨立檢查。修改 η 要另外決定。
- **可信度標記**：
  - **〔raw〕**：直接從原始資料（API 回傳的逐筆 JSON、原始 log）讀到。
  - **〔code〕**：從 benchmark 腳本或原始碼確認的測試條件。
  - **〔推論〕**：本文自行計算或判斷，不是來源寫的。
- **判定**：
  - **usable**：條件齊全，模型在目錄中，可以直接寫成 point。
  - **usable-with-caveat**：可以用，但有一項需要維護者決定（例如需要 schema 擴充、模型要先匯入、引擎不是 vLLM）。
  - **not usable**：缺少條件。

## 重點結論

1. **最好的來源是 SemiAnalysis InferenceX 的公開 API**（`/api/v1/benchmarks`），裡面有逐筆原始結果：
   - 欄位齊全：TP、concurrency、ISL／OSL、image（vLLM 版本）、mean／median TTFT、TPOT、ITL、每 GPU 吞吐量，以及 GitHub Actions run 連結。
   - 測試腳本都在公開 repo，可以用 run 的 commit 查到完整的 `vllm serve` 參數 〔code〕。
   - 模型是目錄裡的 **`gpt-oss-120b`**（`openai/gpt-oss-120b`，原生 MXFP4），引擎是 **vLLM**，平台涵蓋 **H100 與 H200**。
2. **H200 TP=1 的 gpt-oss-120b 點可以直接用**（vLLM v0.22.0，2026-05-30）。
   - 計算機會選「權重放得下的最小 TP，單一 replica」，在 H200 上是 TP=1，和實測的 shape 一致。
3. **H100 的點要先擴充 schema**。InferenceX 在 H100 上只跑 TP=2／4／8，但計算機目前在 `nano5-h100` 會選 TP=1。
   - point 需要能指定 `tp`，否則比較的不是同一個 shape。
   - 加上 `tp` 欄位後，TP>1 的點也能拿來驗證 all-reduce 延遲（p = 2、4、8）。
4. **GB200 沒有可用的 vLLM 公開實測**。
   - InferenceX 的 GB200 gpt-oss 只有 Dynamo + TensorRT-LLM 的 disaggregated（prefill／decode 分離）、multi-node 結果。
   - TensorRT-LLM perf overview 只有最大吞吐量，沒有 concurrency。
   - 兩者都不能當校正點，`nvidia-gb200` 缺口仍要等國網實測（issue #11）。
5. **All-reduce**：
   - H100 p=4 有一組完整的 nccl-tests 原始 log：8 B 時 eager 22.7 µs，CUDA graph 16.1 µs。
   - H200 8-GPU 有論文數字：NCCL ring 4.7–8.9 µs、NVLS 5.6–5.9 µs，但 GPU 數只能從測試環境推得。
   - H100／H200 的 p=2、p=8，以及 GB200 NCCL 的 p=2，都找不到可用的公開小訊息實測。
6. **用目前的資料版本試算，計算機明顯高估 H200 上 gpt-oss-120b 的 decode 速度**（+57% 到 +86%），TTFT 則低估（−63% 到 −90%）〔推論〕。
   - 對照之下，dense 的 Llama 3.3 70B FP8 在 H200 TP=1 上反推的頻寬效率約 0.71，和目前的 etaBw 0.70 接近〔推論〕。
   - 所以 gpt-oss 的落差比較像是 MoE／MXFP4 在 Hopper 上的特性（InferenceX 設了 `VLLM_MXFP4_USE_MARLIN=1`），不是整體 η 的問題。依 R30，這要另外決定，不在本文調整（見 §4）。

## 1. InferenceX：測試條件（gpt-oss-120b，H100／H200，vLLM）

資料取得方式：`GET https://inferencex.semianalysis.com/api/v1/benchmarks?model=gpt-oss-120b&runId=<run>&exactRun=true`。API 說明：<https://inferencex.semianalysis.com/api>，OpenAPI：<https://inferencex.semianalysis.com/api/openapi.json>。

| 項目 | H200 run | H100 run | 標記 |
|---|---|---|---|
| GitHub Actions run | [26696231118](https://github.com/SemiAnalysisAI/InferenceX/actions/runs/26696231118/attempts/1)，2026-05-30 | [25956497716](https://github.com/SemiAnalysisAI/InferenceX/actions/runs/25956497716/attempts/2)，2026-05-17 | 〔raw〕 |
| repo commit | [`f6de379`](https://github.com/SemiAnalysisAI/InferenceX/tree/f6de379efb2a7c28e4584dc36bf30d018a748d9c) | [`be81eac`](https://github.com/SemiAnalysisAI/InferenceX/tree/be81eacf47ae025a9b141585ae321687a19ffe50) | 〔raw〕 |
| image | `vllm/vllm-openai:v0.22.0` | `vllm/vllm-openai:v0.21.0` | 〔raw〕 |
| 模型 | `openai/gpt-oss-120b`，precision 標為 fp4（原生 MXFP4 checkpoint） | 同左 | 〔code〕 |
| 機器 | runner `h200-cw_*`（CoreWeave）或 `h200-dgxc-slurm_*`（DGX Cloud）。TP=1、1k/1k、c=4 跑在 `h200-dgxc-slurm_3`（canary job）；TP=1、8k/1k、c=4 跑在 `h200-dgxc-slurm_0` | `h100-dgxc-slurm_*`、`h100-cw_*`。TP=2、1k/1k、c=4 跑在 `h100-dgxc-slurm_00` | 〔raw〕（jobs API 的 `runner_name`） |
| 啟動參數 | `vllm serve … --gpu-memory-utilization 0.9 --tensor-parallel-size $TP --max-num-seqs $CONC`，config：`no-enable-prefix-caching`、`max-cudagraph-capture-size 2048`、`max-num-batched-tokens 8192`、`max-model-len` = ISL+OSL+20（1k/1k）或 ISL+OSL+256（8k/1k）；環境變數 `VLLM_MXFP4_USE_MARLIN=1`、`TORCH_CUDA_ARCH_LIST=9.0` | 同左，但 `max-model-len 10240` 固定；有 `VLLM_MXFP4_USE_MARLIN=1` | 〔code〕[H200 腳本](https://github.com/SemiAnalysisAI/InferenceX/blob/f6de379efb2a7c28e4584dc36bf30d018a748d9c/benchmarks/single_node/gptoss_fp4_h200.sh)、[H100 腳本](https://github.com/SemiAnalysisAI/InferenceX/blob/be81eacf47ae025a9b141585ae321687a19ffe50/benchmarks/single_node/gptoss_fp4_h100.sh) |
| KV cache dtype | 未設定（vLLM 預設，跟著模型 dtype） | 同左 | 〔code〕 |
| 客戶端 | repo 內的 `utils/bench_serving/benchmark_serving.py`：`--dataset-name random --request-rate inf --ignore-eos --max-concurrency $CONC --num-prompts CONC×10 --num-warmups 2×CONC`；沒有用 chat template | 同左 | 〔code〕[benchmark_lib.sh](https://github.com/SemiAnalysisAI/InferenceX/blob/f6de379efb2a7c28e4584dc36bf30d018a748d9c/benchmarks/benchmark_lib.sh) |
| 長度分布 | `RANDOM_RANGE_RATIO=0.8`：輸入與輸出長度各自在 `[int(0.8×L), L]` 均勻抽樣（整數）。1k 為 819–1024（平均 921.5），8k 為 6553–8192（平均 7372.5）。prompt 會反覆重新 tokenize，補足或截斷到目標長度 | 同左 | 〔code〕[benchmark_serving.py `sample_uniform`](https://github.com/SemiAnalysisAI/InferenceX/blob/f6de379efb2a7c28e4584dc36bf30d018a748d9c/utils/bench_serving/benchmark_serving.py)、[benchmark-tmpl.yml](https://github.com/SemiAnalysisAI/InferenceX/blob/f6de379efb2a7c28e4584dc36bf30d018a748d9c/.github/workflows/benchmark-tmpl.yml) |
| 指標定義 | TTFT 與 TPOT 是每個 request 的值；API 給 mean、median、p90、p99。`tput_per_gpu` 是（輸入＋輸出）tok/s ÷ GPU 數 | 同左 | 〔raw〕 |

**與計算機假設的差異**（都是 caveat，不是排除理由）：

- **長度**：計算機的 workload 只有單一長度，InferenceX 是均勻分布。建議 point 用分布平均值（922／7373），並在 basis 寫明這是平均值；也可以直接用名目值（1024／8192），由維護者決定〔推論〕。
- **記憶體比例**：`gpu-memory-utilization` 是 0.9，計算機是 0.92。這只影響 KV 容量，不影響每步讀取量，而這些點的 concurrency（≤ 64）遠低於容量上限。
- **MoE kernel**：`VLLM_MXFP4_USE_MARLIN=1` 讓 Hopper 改走 Marlin MXFP4 kernel。計算機產生的驗證指令沒有這個旗標，kernel 路徑可能不同。
- **測量次數**：每個 concurrency 只有 CONC×10 個 request（c=4 時只有 40 個），平均值有抽樣雜訊。
- **異常值**：少數組合的 mean TTFT 明顯偏高，例如 H200 TP=1、8k/1k、c=16 的 mean TTFT 10.98 s，但 median 只有 1.31 s。這類點不建議採用。

## 2. 候選點總表

### 2a. Serving（decode／TTFT）

decode tok/s 是由 TPOT 換算的 **1000 ÷ mean TPOT（ms）**〔推論〕。TTFT 都是 mean，括號內是 median。

| # | 平台 | 引擎／版本 | 模型（HF id）／精度 | TP | 輸入/輸出 | conc | TPOT mean (ms) → decode tok/s | TTFT mean (median) s | 判定 | 原因 |
|---|---|---|---|---|---|---|---|---|---|---|
| C1 | H200 | vLLM v0.22.0 | `openai/gpt-oss-120b` MXFP4（目錄：gpt-oss-120b） | 1 | 1024/1024（0.8–1.0） | 4 | 6.34 → 157.7 | 0.096 (0.082) | **usable** | shape 與計算機一致（TP=1） |
| C2 | H200 | vLLM v0.22.0 | 同上 | 1 | 8192/1024 | 4 | 7.15 → 139.9 | 0.418 (0.349) | **usable** | 同上；TTFT 以 prefill 為主 |
| C3 | H200 | vLLM v0.22.0 | 同上 | 1 | 8192/1024 | 8 | 10.42 → 96.0 | 0.501 (0.350) | **usable** | 同上 |
| C4 | H200 | vLLM v0.22.0 | 同上 | 1 | 8192/1024 | 32 | 24.90 → 40.2 | 0.983 (0.397) | **usable** | 同上；mean 與 median 的 TTFT 差很多，表示有排隊 |
| C5 | H200 | vLLM v0.22.0 | 同上 | 1 | 8192/1024 | 64 | 41.86 → 23.9 | 1.524 (0.437) | **usable** | 同上 |
| C6 | H200 | vLLM v0.22.0 | 同上 | 1 | 8192/1024 | 16 | 12.18 → 82.1 | 10.983 (1.312) | not usable | TTFT 異常（mean 是 median 的 8 倍），TPOT 也不符合 c=8 到 c=32 之間的趨勢 |
| C7 | H200 | vLLM v0.18.0 | 同上 | 1 | 1024/8192 | 4 | 6.15 → 162.6 | 0.096 (0.085) | usable-with-caveat | 版本不同（2026-03-27，run [23636886937](https://github.com/SemiAnalysisAI/InferenceX/actions/runs/23636886937/attempts/2)），可當跨版本的獨立驗證 |
| C8 | H200 | vLLM v0.22.0 | 同上 | 2 | 1024/1024 | 4 | 4.86 → 205.8 | 0.066 (0.057) | usable-with-caveat | 需要 schema 加 `tp`（計算機會選 TP=1） |
| C9 | H200 | vLLM v0.22.0 | 同上 | 8 | 1024/1024 | 4 | 3.70 → 270.3 | 0.040 (0.034) | usable-with-caveat | 需要 `tp`；可驗證 p=8 的 all-reduce |
| C10 | H100 | vLLM v0.21.0 | 同上 | 2 | 1024/1024 | 4 | 5.14 → 194.6 | 0.070 (0.058) | usable-with-caveat | 需要 `tp`。計算機在 H100 選 TP=1，實測沒有 TP=1 |
| C11 | H100 | vLLM v0.21.0 | 同上 | 2 | 8192/1024 | 4 | 5.65 → 177.0 | 0.278 (0.239) | usable-with-caveat | 同上 |
| C12 | H100 | vLLM v0.21.0 | 同上 | 4 | 1024/1024 | 4 | 4.10 → 243.9 | 0.050 (0.045) | usable-with-caveat | 同上；可驗證 p=4 的 all-reduce |
| C13 | H100 | vLLM v0.21.0 | 同上 | 8 | 1024/1024 | 4 | 3.75 → 266.7 | 0.039 (0.035) | usable-with-caveat | 同上；可驗證 p=8 的 all-reduce |
| C14 | H100 | vLLM v0.21.0 | 同上 | 2 | 1024/1024 | 64 | 14.83 → 67.4 | 0.215 (0.087) | usable-with-caveat | 同上；高 concurrency |
| C15 | H200 | vLLM v0.10.2 | `nvidia/Llama-3.3-70B-Instruct-FP8`（NVIDIA 發表，非 gated；不在目錄） | 1 | 1024/1024 | 4 | 21.47 → 46.6 | 0.203 (0.175) | usable-with-caveat | 模型要先匯入；`kv-cache-dtype fp8`、`async-scheduling`；客戶端是 run 時才 clone 的 `kimbochen/bench_serving`（沒有固定 commit）；2025-10-29，run [18924448230](https://github.com/SemiAnalysisAI/InferenceX/actions/runs/18924448230/attempts/2) |
| C16 | H200 | vLLM v0.10.2 | 同上 | 1 | 8192/1024 | 4 | 26.14 → 38.3 | 1.345 (1.166) | usable-with-caveat | 同上；run [18924487526](https://github.com/SemiAnalysisAI/InferenceX/actions/runs/18924487526/attempts/3) |
| C17 | H100 | vLLM v0.10.2 | 同上 | 2 | 1024/1024 | 4 | 17.41 → 57.4 | 0.121 (0.108) | usable-with-caveat | 同上，另外需要 `tp`（dense 70B FP8 在 H100 單卡放不下，計算機可能本來就選 TP=2，待確認）。**2026-10-20 更正（最終審查 I5）**：H100 的啟動參數 `--max-model-len` 是 **10240**，不是 H200 的 2068：run 18924448230（head 9596d23）用的 [`benchmarks/70b_fp8_h100_slurm.sh`](https://github.com/SemiAnalysisAI/InferenceX/blob/9596d23d74e9e1e4f4bcdb27572c87cafb746a02/benchmarks/70b_fp8_h100_slurm.sh#L19-L25)（`_docker.sh` 相同）在 config.yaml 寫死 `max-model-len: 10240`，H200 的 [`70b_fp8_h200_slurm.sh`](https://github.com/SemiAnalysisAI/InferenceX/blob/9596d23d74e9e1e4f4bcdb27572c87cafb746a02/benchmarks/70b_fp8_h200_slurm.sh#L23-L39) 才以 ISL + OSL + 20 計算。6 個 H100 點（`ix-h100-llama70b-fp8-tp{2,4,8}-1k1k-c4[-ttft]`）的 engineArgs 已更正並列入 deviations；只影響 KV 容量，不影響這些點的預測 |
| C18 | GB200 | Dynamo + TRT-LLM `tensorrtllm-runtime:0.7.0.post2` | `openai/gpt-oss-120b` | decode TP4 | 1024/1024 | 1 | 1.90 → 526 | 0.037 | not usable | 引擎不是 vLLM；prefill 與 decode 分離（disaggregated）、multi-node，計算機不模擬這種部署（run [20786863188](https://github.com/SemiAnalysisAI/InferenceX/actions/runs/20786863188/attempts/3)） |
| C19 | GB200／H200／H100 | TRT-LLM（perf overview，commit 6e1cc95） | gpt-oss-120b：GB200 TP1 FP4、H200 TP1、H100 DEP4；Llama 3.3 70B：`nvidia/Llama-3.3-70B-Instruct-FP4`／`-FP8` | 見左 | 1024/1024 等 | 未載明 | 只有「output tok/s/GPU」最大吞吐量（例如 gpt-oss 1024/1024：GB200 26,609、H200 6,798、H100 4,715） | 無 | not usable | 沒有 concurrency（「all requests are queued in rapid succession」）、沒有 TTFT／TPOT；計算機沒有對應的最大吞吐量指標。[perf overview](https://nvidia.github.io/TensorRT-LLM/1.3.0rc27/developer-guide/perf-overview.html) |
| C20 | H200 | vLLM（Dynamo recipe，版本未載明） | `openai/gpt-oss-120b` + EAGLE3 | 8 × TP1 replica | 64K/400 agentic trace | 256 | 47.5 tok/s/user | 1.4 | not usable | 有 speculative decoding、90% KV cache 命中、CPU offload，而且頁面自稱「throughput proxy」。[Dynamo recipe](https://docs.nvidia.com/dynamo/zh-CN/dev/recipes/gpt-oss-120b.md) |
| C21 | H100 | vLLM（InferenceX run 頁） | gpt-oss-120b | 未載明 | 8k/1k | 未載明 | 只有內插的 tok/s/GPU 對 tok/s/user | 頁面顯示 0.0 ms | not usable | 內插值，不是實測點，請改用 API 的原始資料。[run 頁](https://inferencex.semianalysis.com/run/gptoss-120b-on-h100) |
| C22 | 各平台 | MLPerf Inference（多數是 TRT-LLM） | Llama 2 70B、Llama 3.1 405B／8B、gpt-oss-120b 等 | 各異 | 資料集長度分布 | 情境決定 | Offline tok/s、Server QPS | 只有延遲上限，不是實測值 | not usable | 長度依資料集分布，不是固定值；只回報吞吐量。這次也沒有取得 v6.0 官方結果表，只看到第三方摘要（[Spheron](https://www.spheron.network/blog/mlperf-inference-v6-benchmark-results-2026/)） |
| C23 | B200／GB200／H200 | SGLang（InferenceX） | `meta-models/Muse-Spark-Open-816B-A42B-NVFP4` 等 | 各異 | agentic traces | 各異 | — | — | not usable | 都是 agentic trace（沒有固定長度），多數有 speculative decoding 或 KV offload，模型也不在目錄 |

### 2b. All-reduce 小訊息延遲

| # | 硬體 | p | 工具 | 數值 | 判定 | 原因 |
|---|---|---|---|---|---|---|
| A1 | 8× H100 80GB HBM3（NVSwitch 主機中的 4 張） | 4 | nccl-tests `all_reduce_perf`，`-b 8 -e 8G -f 2`，50 iters，`graph: 0`，float sum，out-of-place | 8 B：**22.72 µs**；1 KB：23.67；8 KB：24.73；64 KB：26.20 µs 〔raw〕 | usable-with-caveat | 版本有矛盾：作者寫 NCCL 2.18.3，但 log 標頭是 `nccl-tests version 2.18.3 nccl-headers=22902 nccl-library=22902`，也就是 NCCL 函式庫 2.29.2，2.18.3 是 nccl-tests 的版本〔推論〕。主機上有其他租戶（作者有記錄），eager 模式。[results/all_reduce.txt](https://github.com/waynehacking8/nccl-collectives-bench/blob/38c093eda275208e175abd3969c14e1316fe50e6/results/all_reduce.txt) |
| A2 | 同上 | 4 | 同上，`graph: 1`（CUDA graph），`-e 16M` | 8 B：**16.08 µs**；1 KB：16.88；8 KB：15.46；64 KB：16.76 µs 〔raw〕 | usable-with-caveat | 比較接近 vLLM decode 的情況（decode 會用 CUDA graph）。但 vLLM 小訊息在 NVLink 上通常走自己的 custom all-reduce，不是 NCCL，這個值只能當上限參考〔推論〕。[symmetric/all_reduce_reg0_graph1.txt](https://github.com/waynehacking8/nccl-collectives-bench/blob/38c093eda275208e175abd3969c14e1316fe50e6/results/symmetric/all_reduce_reg0_graph1.txt) |
| A3 | 同上（quiet box 重測） | 4 | PyTorch `dist.all_reduce` bf16，200 iters，eager 對 CUDA graph | 1 KB：eager 22.5／graph 11.8 µs；8 KB：graph 12.3；64 KB：graph 13.6 µs 〔raw〕 | usable-with-caveat | 不是 nccl-tests，是 torch.distributed（底層仍是 NCCL）。[results/quiet/tp_latency.json](https://github.com/waynehacking8/nccl-collectives-bench/blob/38c093eda275208e175abd3969c14e1316fe50e6/results/quiet/tp_latency.json) |
| A4 | 8× H200 SXM5（CoreWeave，NVLink-4、NVLS） | 未明寫（測試環境是每節點 8 GPU） | nccl-tests（官方 repo），CUDA graph | 64 KiB 以下：NCCL ring「roughly 4.7–8.9 μs」、NCCL NVLS「5.6–5.9 μs」 | usable-with-caveat | GPU 數、NCCL 版本、各訊息大小的數值都沒有寫出（數值只在圖上）。數字比 A2 低很多，兩者衝突，需要國網實測釐清。[arXiv 2606.05951](https://arxiv.org/html/2606.05951) |
| A5 | GB200 NVL72 | 4 | 論文自己的 harness，NCCL v2.29.1，10 trials 平均 | NCCL ring 小訊息平均 **11.0 µs**（論文自己的 kernel 是 2.37 µs） | 已在使用 | 目前 `allreduceLatencyUs` 的來源。訊息大小沒有寫出。[arXiv 2607.16100](https://arxiv.org/html/2607.16100) |
| A6 | GB200 NVL72 | 2 | 同上 | 只有理論下限（SoL）1.404 µs；NCCL 的數值只畫在 Fig. 11 | not usable | 文字裡沒有 NCCL 在 p=2 的實測數值 |
| A7 | 8× H200／H800、8× B200 | 8 | 論壇貼文，「same tuning methods」 | 8 B 約 2.3 µs（Hopper）、約 3 µs（B200） | not usable | 調校方式、NCCL 版本、模式都沒有寫，GPU 也沒有分清 H200 或 H800。[NVIDIA forum](https://forums.developer.nvidia.com/t/inter-gpu-latency-on-b200-higher-than-on-hopper/352473) |

## 3. 哪些點用到目錄模型、哪些需要匯入

| 模型 | 目錄 | 候選點 |
|---|---|---|
| `openai/gpt-oss-120b`（目錄 `gpt-oss-120b`，commit `b5c939d`；HF 目前的 sha 也是 `b5c939d`） | 已在目錄 | C1–C14 |
| `nvidia/Llama-3.3-70B-Instruct-FP8`（NVIDIA，US；base 是 meta-llama/Llama-3.3-70B-Instruct；HF API 顯示 `gated: false`） | **需要匯入**（`pnpm data:import nvidia/Llama-3.3-70B-Instruct-FP8 --developer NVIDIA --country US`） | C15–C17 |

dense 模型的點很有價值：可以把「整體頻寬效率」和「MoE／MXFP4 的特殊行為」分開來看（見 §4）。

## 4. 目前計算機的試算（只供參考，不得用來調 η）

- **方法**：以資料版本 `b035d50` 呼叫 `predictMeasurement`，參數是 expected η、cacheHitRate 0，輸入/輸出長度用分布平均（922／7373）。腳本放在 scratchpad，不在 repo 裡〔推論〕。
- **誤差**：誤差 = 預測 ÷ 實測 − 1。

| 點 | 計算機 shape | 預測 decode | 實測 decode | 誤差 | 預測 TTFT | 實測 TTFT（mean） | 誤差 |
|---|---|---|---|---|---|---|---|
| C1 H200 1k/1k c4 | TP1, bw-bound | 280.1 | 157.7 | +78% | 0.019 s | 0.096 s | −80% |
| C2 H200 8k/1k c4 | TP1, bw-bound | 259.5 | 139.9 | +86% | 0.154 s | 0.418 s | −63% |
| C3 H200 8k/1k c8 | TP1 | 162.3 | 96.0 | +69% | 0.154 s | 0.501 s | −69% |
| C4 H200 8k/1k c32 | TP1 | 63.0 | 40.2 | +57% | 0.154 s | 0.983 s | −84% |
| C5 H200 8k/1k c64 | TP1 | 43.9 | 23.9 | +84% | 0.154 s | 1.524 s | −90% |
| C10 H100 1k/1k c4 | **TP1**（實測是 TP2） | 195.5 | 194.6 | 0% | 0.028 s | 0.070 s | −60% |

**解讀**〔推論〕：

- **decode**：H200 的 gpt-oss-120b 一致高估 57%–86%，遠超出 ±25% 容許範圍。
  - Llama 3.3 70B FP8 在 H200 TP1 c4 的粗略反推：
    - 每步讀取 ≈ 68.45 GB FP8 線性層 + 4.20 GB BF16 embedding／lm_head + 約 0.9 GB fp8 KV（4 人 × 約 1383 token × 163,840 B/token），合計 ≈ 73.6 GB。
    - 理論時間 ÷ 實測 TPOT = (73.6 GB ÷ 4.8 TB/s) ÷ 21.47 ms ≈ **0.71**，和 etaBw 0.70 一致。
  - 所以落差比較可能來自 MoE 的部分：MXFP4 Marlin kernel 在 Hopper 上的效率，以及 batch > 1 時路由專家聯集的讀取量模型。不像是平台整體的 etaBw。
- **H100 C10 的 0% 是巧合**：計算機算的是 TP1，實測是 TP2，不能當成驗證通過。
- **TTFT**：一致低估。短 prompt（922 token）時，預測只有 19–28 ms，但實測有 70–96 ms，顯示 `tFixedSec`（目前是 0）有幾十 ms 的量級。高 concurrency 時，mean TTFT 還包含被其他 request 的 prefill 擋住的時間。
- **依 R30**：以上都不是調整 η 的依據。是否把 C1／C2 當成 fit 點、是否為 MoE／MXFP4 另立參數，要由維護者另外決定。

## 5. 建議加入 `config/calibration.yaml` 的點

前提：

- `sources.yaml` 要新增來源 id，例如：
  - `inferencex-gptoss-h200-v022`：API URL + run 26696231118
  - `inferencex-gptoss-h200-v018`：run 23636886937
  - `inferencex-gptoss-h100-v021`：run 25956497716
  - `inferencex-llama70b-fp8-v0102`：run 18924448230／18924487526
  - `nccl-collectives-bench-h100`：commit `38c093e`
- workload 長度是用分布平均值或名目值，由維護者決定（本表用平均值）。

### 5a. 現在就能加（schema 不用改）

| 建議 id | role | 平台 | 模型/quant | workload | conc | metric | measured | 影響的參數 |
|---|---|---|---|---|---|---|---|---|
| `ix-h200-gptoss-mxfp4-1k1k-c4` | fit（若決定用它設定 etaBw）或 validate | nano5-h200 | gpt-oss-120b / mxfp4 | 922 / 922 | 4 | decodeTokPerSec | 157.7（1000 ÷ 6.34 ms） | `nvidia-default.etaBw`（MoE 路徑） |
| `ix-h200-gptoss-mxfp4-1k1k-c4-ttft` | fit | nano5-h200 | 同上 | 922 / 922 | 4 | ttftSec | 0.096 | `tFixedSec`（prefill 很短，固定開銷佔大部分） |
| `ix-h200-gptoss-mxfp4-8k1k-c4` | validate | nano5-h200 | 同上 | 7373 / 922 | 4 | decodeTokPerSec | 139.9 | etaBw（較長的 KV） |
| `ix-h200-gptoss-mxfp4-8k1k-c4-ttft` | fit | nano5-h200 | 同上 | 7373 / 922 | 4 | ttftSec | 0.418 | `etaCompute`（扣掉 tFixedSec 後） |
| `ix-h200-gptoss-mxfp4-8k1k-c8` | validate | nano5-h200 | 同上 | 7373 / 922 | 8 | decodeTokPerSec | 96.0 | batch 擴展與 MoE 專家聯集 |
| `ix-h200-gptoss-mxfp4-8k1k-c32` | validate | nano5-h200 | 同上 | 7373 / 922 | 32 | decodeTokPerSec | 40.2 | 同上，加上 prefill 干擾（R29） |
| `ix-h200-gptoss-mxfp4-8k1k-c64` | validate | nano5-h200 | 同上 | 7373 / 922 | 64 | decodeTokPerSec | 23.9 | 同上；也可以當 etaBwLow 的參考 |
| `ix-h200-gptoss-mxfp4-8k1k-c64-ttft` | validate | nano5-h200 | 同上 | 7373 / 922 | 64 | ttftSec | 1.524 | 排隊（Little's law，R36）與 prefill 干擾 |
| `ix-h200-gptoss-mxfp4-1k8k-c4-v018` | validate | nano5-h200 | 同上 | 922 / 7373 | 4 | decodeTokPerSec | 162.6 | 跨 vLLM 版本（v0.18.0）的 etaBw 檢查 |

所有點都填 `engine: vllm`。`measured.status` 建議用 `measured`，並在 basis 註明「TPOT 換算」。

### 5b. 需要 schema 擴充（point 加 `tp`，predictMeasurement 改用指定的 TP）

| 建議 id | role | 平台 | TP | workload | conc | metric | measured | 影響的參數 |
|---|---|---|---|---|---|---|---|---|
| `ix-h100-gptoss-mxfp4-1k1k-tp2-c4` | validate | nano5-h100 | 2 | 922 / 922 | 4 | decodeTokPerSec | 194.6 | H100 的 etaBw + p=2 all-reduce |
| `ix-h100-gptoss-mxfp4-1k1k-tp4-c4` | validate | nano5-h100 | 4 | 922 / 922 | 4 | decodeTokPerSec | 243.9 | p=4 all-reduce（可和 A2 對照） |
| `ix-h100-gptoss-mxfp4-1k1k-tp8-c4` | validate | nano5-h100 | 8 | 922 / 922 | 4 | decodeTokPerSec | 266.7 | p=8 all-reduce（目前是用 GB200 的 p=4 外推） |
| `ix-h200-gptoss-mxfp4-1k1k-tp8-c4` | validate | nano5-h200 | 8 | 922 / 922 | 4 | decodeTokPerSec | 270.3 | 同上 |
| `ix-h100-gptoss-mxfp4-8k1k-tp2-c4-ttft` | validate | nano5-h100 | 2 | 7373 / 922 | 4 | ttftSec | 0.278 | H100 的 etaCompute |

### 5c. 需要先匯入模型（dense 對照組）

| 建議 id | role | 平台 | 模型/quant | workload | conc | metric | measured | 影響的參數 |
|---|---|---|---|---|---|---|---|---|
| `ix-h200-llama70b-fp8-1k1k-c4` | validate（或改當 dense 的 fit） | nano5-h200 | llama-3.3-70b-instruct-fp8 / fp8（KV 用 fp8） | 922 / 922 | 4 | decodeTokPerSec | 46.6 | dense 路徑的 etaBw（反推約 0.71） |
| `ix-h200-llama70b-fp8-8k1k-c4-ttft` | validate | nano5-h200 | 同上 | 7373 / 922 | 4 | ttftSec | 1.345 | dense 的 etaCompute |

**注意**：這組的 `kv-cache-dtype fp8` 與計算機的 KV 精度設定是否一致，要先確認。客戶端版本沒有固定，所以只建議當 validate。

### 5d. All-reduce（`allreduceLatencyUs`）

- 目前 H100／H200 的值是借用 GB200 p=4 的 11 µs（R23）。
- 可以改用 A2 的 **H100 p=4 CUDA graph 16.1 µs（8 B）**，標為 `status: measured`、使用範圍只限 p=4；或保留 11 µs，把 A1／A2 列為 evidence。
- A4（H200 4.7–8.9 µs）和 A2 互相衝突，GPU 數也不明確，**不建議單獨採用**。
- 這屬於另外的 η／參數決定（R30），本文不做結論。

## 6. 仍需國網實測的缺口

- **issue #10（H100／H200）**：
  - **H100 TP=1** 的 gpt-oss-120b：公開資料沒有，而計算機在 H100 選的正是 TP=1。
  - **phi-4、mistral-small-4-119b-2603**：完全沒有公開的 H100／H200 vLLM 實測。
  - **MoE 落差的原因**：同一組條件下，比較有沒有設 `VLLM_MXFP4_USE_MARLIN=1`。
  - **All-reduce p=2、p=8**：H100／H200 沒有可用的小訊息實測；p=4 只有 A1／A2 這一組第三方數字（有其他租戶）。
  - **H200 all-reduce 數字互相衝突**（A2 對 A4），需要國網用 nccl-tests 在 eager 與 `-G`（graph）兩種模式各量一次。
  - **`tFixedSec`**：從 C1 看是幾十 ms 的量級，需要國網用 concurrency 1、短 prompt 量測確認。
- **issue #11（GB200）**：
  - **vLLM decode／TTFT**：TP=1、2、4 都沒有公開實測；GB200 的公開資料只有 TRT-LLM（disaggregated 或最大吞吐量）。
  - **All-reduce p=2**：NCCL 只有圖上的數值，文字沒有寫出。
  - **每節點 GPU 數與 HCA 數**：公開來源沒有新的資訊，仍需國網系統組確認。

## 7. 採用情形（2026-10-20，Ruling R41）

- **採用的點**：20 個 InferenceX run，各取 decode 與 TTFT，共 40 點寫進 `config/calibration.yaml`，每點都有 `tp`、`concurrency`、長度平均值（922／7373）與 `conditions`（引擎版本、啟動參數、環境變數、客戶端、run 連結、deviations）。
  - gpt-oss-120b（H200 v0.22.0）：TP1 1k/1k c4；TP1 8k/1k c4／c8／c32／c64；TP2／TP4／TP8 1k/1k c4（C1–C5、C8、C9，另加 TP4）。
  - gpt-oss-120b（H100 v0.21.0）：TP2 1k/1k c4、TP2 8k/1k c4、TP4、TP8 1k/1k c4、TP2 1k/1k c64（C10–C14）。
  - Llama-3.3-70B-Instruct-FP8（v0.10.2）：H200 TP1 1k/1k、8k/1k c4，TP2、TP4 1k/1k c4；H100 TP2、TP4、TP8 1k/1k c4（C15–C17，另加 TP 變化）。模型以 `pnpm data:import nvidia/Llama-3.3-70B-Instruct-FP8 --developer NVIDIA --country US --revision fde04ee` 匯入；這個 checkpoint 的量化設定在 ModelOpt 的 `hf_quant_config.json`，匯入工具因此新增支援（`config/models/README.md`）。
  - 不採用：C6（H200 TP1 8k/1k c16，列在 `skipped`）、C7（v0.18.0 1k/8k）、C18–C23（理由同 §2）。
- **fit 點（擬合前宣告）**：H200 TP1 1k/1k c4 的 gpt-oss-120b 與 Llama-3.3-70B-FP8，decode 與 TTFT 各 1 點。其餘 36 點是 validate。
- **結構比較與決定**（詳見 spec §5.6 Ruling R41、`calibration.yaml` 開頭）：

| 結構（只用 fit 點擬合） | decode validate 平均絕對誤差 | ±25% 內（18 點） | 判斷 |
|---|---|---|---|
| (0) 原本：η_bw 0.70、t_fixed 0 | 76% | 5 | 全面高估 gpt-oss，TP 越大越高估 |
| (a) 每步固定 t_fixed = 2.9 ms，η 不變 | **15%** | **16** | **採用** |
| (b) 每層 t_fixed = 層數 × 69 µs | 17% | 15 | TP 變大的 Llama 低估 −18% 到 −23% |
| (c) η_bw 0.835 + t_fixed 3.6 ms（聯合） | 19% | 16 | 高 TP 的 gpt-oss 低估、c=64 高估 +86% |
| (c') η_bw + 每層 τ（聯合） | — | — | 需要 η_bw 1.34 > 1，不合物理 |
| (d) 只有 MXFP4 專家讀取效率 0.29，t_fixed 0 | 34% | 11 | TP=8 高估 +93% 到 +132% |

  - TTFT：每請求開銷 `ttftOverheadSec` = 74 ms（兩個 TTFT fit 點擬合）；TTFT validate 平均絕對誤差 66% → 54%，±25% 內 1 → 3 點。剩下的誤差看起來是「c + k ÷ TP」（c 約 30–40 ms、k 依模型而異），兩個 fit 點無法分辨，留給 issue #10。
- **validate 殘差（採用後）**：decode 只有 gpt-oss H200 8k/1k c32（+35%）、c64（+65%）在 ±25% 外；TTFT 有 15 點在外（TP ≥ 2 的 1k prompt 高估 +22% 到 +111%，8k prompt 低估 −13% 到 −54%，c=32／64 的 mean TTFT 低估 −57% 到 −85%，後者含開頭同時送出時的排隊）。`pnpm calibrate` 以 WARN 回報，exit 0。
- **MXFP4 kernel**：InferenceX 的 `VLLM_MXFP4_USE_MARLIN=1` 在 v0.21／v0.22 強制 Marlin；v0.32.0 的預設（Hopper）是 OAI Triton，這個環境變數已移除，改用 `--moe-backend marlin`（`docs/research/vllm-tp-kv-precision.md` §9）。驗證指令維持預設 kernel，註解寫明校正點是 Marlin。
- **All-reduce**：維持 11 µs（estimate）。A1／A2（H100 4-GPU 16–23 µs）與 A4（H200 4.7–8.9 µs）互相矛盾；TP2／4／8 的 validate 點在 11 µs 時都在 ±25% 內，用 16–23 µs 會系統性低估 14–28%，偏向 ≤ 11 µs，但 validate 點不能拿來設定數值（R30）。A1、A2、A4 列為 evidence，待國網量測。
- **缺口**：`nvidia-hgx` 已從 gaps 移除；`nvidia-gb200` 保留（R41 的開銷在 GB200 是外推）。

## 來源

- [S1] SemiAnalysis InferenceX API 說明：<https://inferencex.semianalysis.com/api> ；OpenAPI：<https://inferencex.semianalysis.com/api/openapi.json>
- [S2] gpt-oss-120b 原始結果（H200，v0.22.0）：<https://inferencex.semianalysis.com/api/v1/benchmarks?model=gpt-oss-120b&runId=26696231118&exactRun=true>
- [S3] gpt-oss-120b 原始結果（H100，v0.21.0）：<https://inferencex.semianalysis.com/api/v1/benchmarks?model=gpt-oss-120b&runId=25956497716&exactRun=true>
- [S4] gpt-oss-120b 全部最新結果（含 v0.18.0 的 1k/8k、GB200 Dynamo-TRT）：<https://inferencex.semianalysis.com/api/v1/benchmarks?model=gpt-oss-120b>
- [S5] Llama 3.3 70B FP8 原始結果：<https://inferencex.semianalysis.com/api/v1/benchmarks?model=Llama-3.3-70B-Instruct-FP8>
- [S6] GitHub Actions runs：
  - <https://github.com/SemiAnalysisAI/InferenceX/actions/runs/26696231118/attempts/1>
  - <https://github.com/SemiAnalysisAI/InferenceX/actions/runs/25956497716/attempts/2>
  - <https://github.com/SemiAnalysisAI/InferenceX/actions/runs/23636886937/attempts/2>
  - <https://github.com/SemiAnalysisAI/InferenceX/actions/runs/18924448230/attempts/2>
  - <https://github.com/SemiAnalysisAI/InferenceX/actions/runs/18924487526/attempts/3>
  - <https://github.com/SemiAnalysisAI/InferenceX/actions/runs/20786863188/attempts/3>
- [S7] InferenceX 腳本與設定（固定 commit）：
  - H200：<https://github.com/SemiAnalysisAI/InferenceX/blob/f6de379efb2a7c28e4584dc36bf30d018a748d9c/benchmarks/single_node/gptoss_fp4_h200.sh>
  - H100：<https://github.com/SemiAnalysisAI/InferenceX/blob/be81eacf47ae025a9b141585ae321687a19ffe50/benchmarks/single_node/gptoss_fp4_h100.sh>
  - nvidia-master.yaml：<https://github.com/SemiAnalysisAI/InferenceX/blob/f6de379efb2a7c28e4584dc36bf30d018a748d9c/.github/configs/nvidia-master.yaml>
  - benchmark_lib.sh：<https://github.com/SemiAnalysisAI/InferenceX/blob/f6de379efb2a7c28e4584dc36bf30d018a748d9c/benchmarks/benchmark_lib.sh>
  - benchmark_serving.py：<https://github.com/SemiAnalysisAI/InferenceX/blob/f6de379efb2a7c28e4584dc36bf30d018a748d9c/utils/bench_serving/benchmark_serving.py>
  - Llama 70B（2025-10）：<https://github.com/SemiAnalysisAI/InferenceX/blob/9596d23d74e9e1e4f4bcdb27572c87cafb746a02/.github/workflows/70b-tmpl.yml>、<https://github.com/SemiAnalysisAI/InferenceX/blob/9596d23d74e9e1e4f4bcdb27572c87cafb746a02/benchmarks/70b_fp8_h100_slurm.sh>
- [S8] InferenceX 內插頁面（不採用）：<https://inferencex.semianalysis.com/run/gptoss-120b-on-h100> 、<https://inferencex.semianalysis.com/compare/gptoss-120b-h100-vs-h200>
- [S9] TensorRT-LLM perf overview：<https://nvidia.github.io/TensorRT-LLM/1.3.0rc27/developer-guide/perf-overview.html>
- [S10] NVIDIA Dynamo gpt-oss-120b recipe：<https://docs.nvidia.com/dynamo/zh-CN/dev/recipes/gpt-oss-120b.md>
- [S11] nccl-collectives-bench（H100，commit `38c093e`）：<https://github.com/waynehacking8/nccl-collectives-bench/tree/38c093eda275208e175abd3969c14e1316fe50e6/results> ；作者文章：<https://wayne.is-a.dev/blog/nccl-nvlink-bandwidth/>
- [S12] Demystifying NVSHMEM（H200）：<https://arxiv.org/html/2606.05951>
- [S13] Every Microsecond Matters（GB200 NVL72）：<https://arxiv.org/html/2607.16100>
- [S14] NVIDIA 開發者論壇 B200 對 Hopper 的延遲：<https://forums.developer.nvidia.com/t/inter-gpu-latency-on-b200-higher-than-on-hopper/352473>
- [S15] MLPerf Inference v6.0 第三方摘要（未取得官方表）：<https://www.spheron.network/blog/mlperf-inference-v6-benchmark-results-2026/>
- [S16] HF model repo：<https://huggingface.co/openai/gpt-oss-120b> 、<https://huggingface.co/nvidia/Llama-3.3-70B-Instruct-FP8>
