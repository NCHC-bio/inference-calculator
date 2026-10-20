# 講義公式萃取：計算機的理論依據 [R-LEC]

- **來源**：`reference/EAI_lec4.pptx`，國立陽明交通大學《邊緣人工智慧》第 4 講〈(General-Purpose) AI Accelerators〉，吳凱強老師。此檔案受 `.gitignore` 排除，不納入版本控制。
- **萃取日期**：2026-10-19（初版）。
- **複核**：2026-10-20 全面逐張複核（247 張，所有嵌入圖片）。
  - 方法：每一張投影片的文字框與 `ppt/media` 中被引用的每一張圖片都逐一開啟判讀。圖片依 `slideN.xml.rels` 對應回頁碼，表格儲存格另以 `slideN.xml` 的 `<a:tr>` 核對。
  - 引文照投影片原字；投影片本身的錯字標 [sic]，並寫出應有的讀法。
- **頁碼**：指投影片編號。
- **用法**：計算核心（`packages/core`）的每一條公式，都要能對應到下表的某一列，或對應到 spec §5 中另有出處的推導。程式碼以 `[R-LEC Xn]` 引用；A1–E3 的編號保持不變。
- **連結強度**：
  - **直接**：投影片寫的就是同一個關係。
  - **類比**：結構相同，但場景不同（晶片內 PE、快取、NoC，對應到 GPU、HBM、TP）。
  - **弱**：只有定性或旁及的關係。
  - **推導**：由投影片的式子一般化而來，投影片上沒有寫。
- **單位**：講義 p.36、38、44 的 flop／memory 以「元素（word）」計，Roofline（p.14）以 ops／byte 計。引用時一律以每元素位元組（`bytesPerParam`、KV dtype）換算。

## A. 吞吐量與延遲

| # | 頁 | 講義原文 | 計算機中的對應 | 強度 |
|---|---|---|---|---|
| A1 | 6 | Throughput = 「Amount of data that can be processed/completed in a given time period」，以 Number of operations ⁄ seconds 表示 | 總吞吐 = 同時生成數 × 每人 token/s。token 即「processed data」。 | 直接 |
| A2 | 6 | Latency = time(output generated) − time(input arrives to a system) | **TTFT**：送出請求到第一個 token 出現。講義的延遲是端到端回應時間；**每 token 延遲**（相鄰 token 間隔 = decode 單步時間）是計算機自己的定義，不在講義中。 | 直接（TTFT）；每 token 延遲為計算機定義 |
| A3 | 7 | 「Throughput and latency **can** [sic，依後文範例應為 cannot] be directly derivable from one another」；「Batching input data: Increase throughput but increase latency」；30 fps、批次 100 幀，「some frames will experience at least 3.3 second delay」；「Real-time navigation requires low latency but can bear low throughput」 | 只支持**方向**：同時人數（batch）增加，總吞吐上升、每人延遲上升。講義的機制是「等湊滿一批」；計算機的機制是單步時間隨 B 增加（KV 位元組與 FLOPs 變多）。**速度 vs. 人數曲線的形狀來自 B1 + spec §5.2，不是 A3。** 依講義的原意（不能互推），計算機的每人速度 = 1 ⁄ t_step、總吞吐 = B ⁄ t_step 只在已知 B、穩態連續批次下成立，所以結果一律附上 B（E1）。 | 弱（定性） |
| A4 | 8 | operations⁄second = (1 ⁄ (cycles⁄operation) × cycles⁄second) × number of PEs × utilization of PEs。三項標示：「Peak throughput for a single PE」、「Amount of parallelism」、「degradation due to the inability of the architecture to effectively utilize the PEs」 | **有效算力 = 峰值 FLOPS × η_compute**。前兩項的乘積 = 整顆晶片峰值；η_compute 對應「utilization of PEs」。講義的 utilization 只針對運算；**η_bw 沒有對應的講義項**，是計算機比照加上的（頻寬利用率）。 | 直接（η_compute）；η_bw 為計算機補充 |
| A5 | 8, 15 | inferences⁄second = operations⁄second × 1 ⁄ (operations⁄inference)；前者「Dictated by DNN hardware and DNN models」，後者「Dictated by the DNN model」；p.15「operations/inference depends on the DNN model only」 | **只對應算力受限的分支**：時間 = FLOPs ÷ (峰值 × η_compute)。直接用於 prefill（spec §5.3）與 decode 的算力項；decode 在頻寬受限時改由 B1 決定。**修正**：講義的「只由模型決定」是 CNN 的情況。LLM 每 token FLOPs = 2 × 啟用參數（B8）+ 注意力項，注意力項隨 context 長度變化，所以由**模型 + 工作負載**決定。 | 直接（算力分支） |
| A6 | 10, 11, 101, 153 | p.10：utilization of PEs = (number of active PEs ⁄ number of PEs) × utilization of active PEs；兩項為「Ability to distribute the workload to PEs」、「How efficiently those active PEs are processing the workload」。p.11：active PE 數由 mapping 決定；active PE 的利用率受「Bandwidth and latency of the memory hierarchy and network」、「Imbalance of work allocated across PEs」影響。p.101：「Under-utilization when M < Number of PEs in a column or N < Number of PEs in a row」。p.153：限制 R0·E0 ≤ #PEs | η_compute < 1 的結構性原因。講義的 PE 是同一晶片內的 MAC 單元；拿來說明「工作能否平均分到所有 GPU」、「TP 切分是否平衡」是**類比**。spec 的 η 是推估值，因為這兩項都還沒有國網實測。 | 類比 |
| A7 | 18 | 影響 inferences⁄s 的因素分屬 Hardware、DNN Models、Input Data 三類。表中 **Number of active PEs** 與 **Utilization of active PEs** 都標為 HW + Model；Effectual ops out of total ops 為 Model + Input Data | 設定檔的三類來源：hardware、models、workloads。表格也表示**利用率同時取決於硬體與模型**，但計算機的 η 只依平台的校正設定（見「矛盾」第 5 點）。 | 直接（分類） |
| A8 | 19 | 「#MACs is not a good predictor of latency」；Pixel 手機實測：「Similar Number of MACs, 2× Range in Latency」、「Similar Latency, 3× Range in Number of MACs」 | 計算機**不只用 FLOPs 推算速度**，而是用 Roofline 同時考慮資料搬移（B1），再以實測校正（spec §5.6）。 | 直接 |
| A9 | 237 | 「Define op: Invariant across the different implementations」；「(Convolutional) Neural Networks → Op is one Inference」 | 對外報告的指標是 **token/s 與請求數**（與實作無關的 op），FLOPs 只是內部的工作量模型。 | 直接 |
| A10 | 101, 198 | p.198：「PE array underutilized if there are fewer input and/or output channels than the array dimensions. Effective data delivery BW also becomes lower」 | (a) 小 B 的 decode GEMM 填不滿 tensor core tile，η_compute 偏低；但這個區間由頻寬決定（B1），不影響結果。(b) TP 不能整除注意力頭數時，有些卡會閒置；計算機不建模這種情況，因為 vLLM 直接拒絕（見「講義未涵蓋」）。 | 直接（原理）；類比（GPU） |
| A11 | 28 | Scalability：scaling up to multiple chips is「Usually non-linear when scaling up: Reduced utilization of PEs; Increase cost of data movement」 | 多卡 TP 的加速低於線性；這是 decode 單步加上 t_comm 的定性依據（時間模型見 F3、F6）。 | 直接（定性） |

## B. Roofline 與資料搬移

| # | 頁 | 講義原文 | 計算機中的對應 | 強度 |
|---|---|---|---|---|
| B1 | 14 | **只有圖，沒有寫出式子**。軸：Performance (ops/sec) 對 Operational Intensity (ops/byte)；「Slope = BW」；「Peak Performance」天花板；「Inflection Point」以左為「BW-Limited（Limited by the data delivery）」，以右為「Computation-Limited」。由圖讀出：Performance = min(Peak, BW × OI) | **decode 單步時間 = max(讀取位元組 ⁄ (BW × η_bw), FLOPs ⁄ (Peak × η_compute))**（spec §5.2）。效能取 min 等價於時間取 max；較大者即瓶頸，據此標示「頻寬」或「算力」。**以下是計算機自己加的，不屬於 B1**：η_bw（見 A4）、t_comm（F3、G1）、t_fixed（G2）。 | 直接（由圖讀出） |
| B2 | 14 | 圖上標示轉折點的 x 座標為「Optimal Operational Intensity」；= Peak ⁄ BW 是由圖的幾何推得 | decode 由頻寬受限轉為算力受限的批次大小。忽略 KV 與注意力時：**B\* ≈ Peak × bytesPerParam ⁄ (2 × BW)**。例：H200 FP8 為 1979e12 × 1 ⁄ (2 × 4.8e12) ≈ 206。推導鏈見 B9（p.216 + p.239 + p.14）。這是**推算值**，用於專家檢視的 Roofline 圖。 | 推導 |
| B3 | 12, 116, 121, 123, 148, 190 | p.12：「E.g., Larger batch size → higher amount of data reuse」。p.116：Filter Reuse 適用「CONV and FC layers (batch size > 1)」，重用的是 Filter weights；「If all data reuse is exploited, DRAM accesses in AlexNet can be reduced from 2896M to 61M (best case)」。p.121：N = batch size。p.123：「Weight Size: RSCM, Reuse: EF」（式中沒有 N，即 N = 1）。p.148：WS 欄 Weight Reads = R，Min 欄 = 各張量的唯一大小。p.190：兩個 fmap「share the same filter row」 | 同一步 decode 中，B 個 sequence **共用一次權重讀取**：讀取量 = 權重（只讀一次）+ B × 每個 sequence 的 KV（不共用），即 spec §5.2 的 bytes(B)。FC 層 R = S = E = F = 1，所以 N = 1 時權重重用 = EF = 1，批次為 N 時重用 = N（一行代數，投影片上沒有 N 欄）。講義只說重用「可以」被利用，「每步恰好讀一次」是計算機的建模選擇（條件見 B9）。KV 不在講義中，它相當於每個樣本自己的輸入，沒有跨批次的 filter reuse。**注意**：p.190 標題「Multiple Filters – Fmap Reuse」與圖不符，圖是 Multiple Fmaps – Filter Reuse；p.141–144 的 NVDLA loop nest 把 n 放在最外層，權重載入會隨 N 增加，**不可引用為批次共用的依據**。 | 直接（重用原理）+ 推導（×B） |
| B4 | 44 | 「Why MR × NR block-dot product? Why not a simple scalar dot product? Ratio of floating-point operations to memory operations」。純量內積：2K_c ⁄ (2K_c + 2) ≈ 1。區塊：2·M_R·N_R·K_c ⁄ ((M_R + N_R)·K_c + 2·M_r·N_r) ≈ 2·M_R·N_R ⁄ (M_R + N_R) | 算術強度隨批次上升。取 M_R = B（本步 token 數）、N_R = 權重區塊的輸出維度 N：強度 ≈ 2BN ⁄ (B + N) flop／元素，B ≪ N 時 ≈ 2B，再除以每元素位元組即 2B ⁄ bytesPerParam FLOP／byte（B2 所用的值）；B 接近 N 時趨近 2N 而飽和。**單位是 flop／memory operation（元素）**，不是 byte。投影片假設 C 留在暫存器（p.43），把暫存器 tile 對應到 HBM 層級是類比。 | 直接（式子）；類比（層級） |
| B5 | 103, 116, 148, 151 | p.103（標題 DRAM Access）：「Worse [sic，應為 Worst] Case: all memory R/W are DRAM accesses」；圖：每個 MAC 從 DRAM 讀 3 次（weight、activation、psum）、寫 1 次 | p.103 是**零重用的最壞情況**，每次使用都到 DRAM 抓權重，引用它只為對照。計算機的 bytes(B) 是另一端：**一步之內**每個權重與 KV 位元組只從 HBM 讀一次，即 p.148 Min 欄（每份資料只碰一次）套用到 HBM 層級，也是 p.116 的「best case」；**跨步之間**不保留在晶片內（理由見 B6）。所以相對於真實 kernel（會重讀 tile），這個假設**偏樂觀**，差距由 η_bw 吸收；舊版「偏保守」的說法有誤。 | 直接（Min 計數原理）；類比（HBM 層級） |
| B6 | 104, 94, 119, 151 | p.104：「Extra levels of local memory hierarchy: Smaller, but Faster and more Energy-Efficient」。p.94：「Storage capacity >= maximum reuse distance ⇒ Temporal reuse can be exploited」。p.119：Global Buffer「100s – 1000s kB」、PE Reg File「1 – 10 kB」。p.151：「Level 1 buffer size is volume needed to be preserved and redelivered in future (usually successive) Level 1 iterations」；「A legal assignment of loop limits will fit into the hardware's buffer sizes」 | 跨步重用為何不成立：兩個 decode 步之間，同一個權重的重用距離是整個模型的位元組數，遠大於 GPU L2，不滿足 p.94 的條件，也不是 p.151 定義下的合法配置。一步之內的批次共用只需要「一個權重 tile × B 個 token」的視窗，所以可行。p.119 的大小是一般 spatial accelerator，不是 GPU，只當數量級類比。 | 直接（條件）；類比（GPU） |
| B7 | 36, 234 | p.36 BLAS 表（# mem refs ⁄ # flops ⁄ flop/memory）：L1 Axpy/Dot 3n ⁄ 2n ⁄ 2/3；**L2 GEMV n² ⁄ 2n² ⁄ 2**；**L3 GEMM 4n² ⁄ 2n³ ⁄ n/2**。p.234 圖：DAXPY 與 Non-Blocked GEMV 在 1 以下；Blocked Dense LA 經「Blocking & Packing L2 … LLC」達「>50 ~100」 | B = 1 的 decode 是矩陣 × 向量：每個權重元素只用一次乘加，強度 = 2 flop／元素 = 2 ⁄ bytesPerParam FLOP／byte，遠低於任何 GPU 的 Peak ⁄ BW，所以**受頻寬限制**（B1 左側）。prefill（M = 大量 token）是 GEMM，**受算力限制**，支持 spec §5.3 以 FLOPs ÷ (Peak × η) 計算。注意：p.234 畫的「Blocked GEMV」約達 10，那是向量的重用；單一 GEMV 的權重強度仍是 2 flop／元素，**不可**用來提高 B = 1 的強度。 | 直接 |
| B8 | 38, 216 | p.38：triple loop `C(i,j)=C(i,j)+A(i,k)*B(k,j)`，「Flops = 2 × n³」，「Operate on 3 × n² words of memory」。p.216：A = Input Activation (M×K)、B = Weight (K×N)、C = Output Activation (M×N)，每個 (m, n, k) 一次 MAC | **每 token FLOPs 的線性層項 = 2 × 啟用參數**：每個權重對每個 token 做一次 MAC，一次 MAC = 2 flop（p.38 以 n³ 次乘加計 2n³ flops）。FLOPs 不隨 tiling 改變（p.239：「Highest level always suffers from constant N³ accesses」）。 | 直接 |
| B9 | 216, 239, 242, 14 | p.239（Example: Blocked GEMM）：「A or B From a x a buffer N³/a. C Access for last level cache is 2N². Highest level always suffers from constant N³ accesses to A and B」。p.242：加一層 b×b，「A or B From b x b buffer N³/b. C Access for last level cache is 2N²」 | **推導**（投影片只有 M = N = K、m = n = a 的方陣情況）：以 p.216 的形狀、一層緩衝保留 m×n 的輸出 tile，下層流量為 W：K·N·⌈B⁄m⌉、IA：M·K·⌈N⁄n⌉、C：≤ 2·M·N。decode 的 M = B；B ≤ m 時權重**每步恰好讀一次**（K·N 個元素，與 B 無關），各線性層加總 = 啟用參數 × bytesPerParam，即 B3 的 bytes(B)。B 超過 tile 時權重重讀 ⌈B⁄m⌉ 次，p.242 顯示下一層（約當 GPU L2）可吸收大部分；這種情況是大量 token 的 prefill，本來就受算力限制。**B\* 推導鏈**：FLOPs = 2·B·K·N（B8），權重位元組 = K·N·bytesPerParam，強度 = 2B ⁄ bytesPerParam；令其等於 p.14 的 Peak ⁄ BW，得 B\* = Peak × bytesPerParam ⁄ (2 × BW)（B2）。 | 直接（方陣）+ 推導（一般化） |
| B10 | 212 | 「Little reuse for weights. Especially when the batch size is limited.」配置：「Weights are now unicast to the PEs. Input activations are broadcast to all PEs」。標題印為「Depth-wise CONV Layer」，與內容不符（Eyeriss v2 原文此例為 FC 層），引用內容，不引用標題 | 小 B 時權重幾乎沒有重用，decode 的工作點在 Roofline 左側；B 越大，權重重用越多（B3）。 | 直接（內容） |
| B11 | 223 | 「Short-lived intermediate results. Instead of accessing SRAM or a shared, large register file, consume the intermediate results directly」 | bytes(B) 只計權重與 KV，不計 activation 與 partial sum：融合 kernel 把中間結果留在晶片內，而 decode 的 activation 遠小於權重。 | 類比 |

## C. 精度與稀疏

| # | 頁 | 講義原文 | 計算機中的對應 | 強度 |
|---|---|---|---|---|
| C1 | 17 | 「Lower precision (fewer bits) → lower bandwidth requirement → increase utilization of PEs」；「Multiple levels of precision requires addition [sic，應為 additional] hardware → increase critical path, reduce area density of PE → decrease operations/second」 | 量化的 `bytesPerParam` 直接縮小讀取量（B1 左項）。`computeDtype` 決定採用哪一種峰值 FLOPS，這是計算機的選擇；講義沒有談各 dtype 的峰值，第二句只說明「支援多種精度要付硬體成本」。 | 直接（頻寬）；計算機選擇（dtype 峰值） |
| C2 | 16 | operations⁄cycle = (EO + UIO)⁄cycle × EO⁄(EO + UIO) × 1 ⁄ (EO⁄operations)。EO = effectual operations，UIO = unexploited ineffectual operations。三項標示：「Constant for a given hardware accelerator design」、「Ability of the hardware to exploit ineffectual operations」、「Related to amount of sparsity and depends on the DNN model」 | **只用 dense 峰值**。講義支持的是：稀疏帶來的加速同時需要**模型有稀疏性**（EO⁄operations 項）與**硬體能跳過無效運算**（EO⁄(EO+UIO) 項；UIO 是硬體**沒能跳過**的無效運算）。一般 LLM 推論的權重不是結構化稀疏，所以用 dense 值。**講義沒有談 2:4 結構化稀疏、廠商的「with sparsity」數字或「÷ 2」**；這部分要引用廠商規格（見 `docs/research/nvidia-nchc-hardware.md`），不屬於 R-LEC。 | 直接（原理）；÷ 2 需廠商出處 |
| C3 | 31 | Eyeriss 指標表分列「Bits per weight 16」與「Bits per input activation 16」 | 權重精度與 activation／KV 精度分開揭露（E1）。**不支持**「embedding／lm_head 維持 16-bit」，那條依據是 vLLM（spec §5.1）。 | 弱 |

## D. 能耗與功耗

| # | 頁 | 講義原文 | 計算機中的對應 | 強度 |
|---|---|---|---|---|
| D1 | 21 | Energy efficiency = number of operations ⁄ joule；Power = joules ⁄ second (watt)；「Thermal Design Power (TDP) limits max power consumption」 | **峰值功耗 = GPU 數 × TDP**，是**只算 GPU 的上限**，不是實際耗電，也不含主機、網卡、交換器。「GPU 數 × TDP」的加總是計算機的做法，講義只說 TDP 限制最大功耗。TDP 未查證時不計算（spec Review Focus #4）。 | 直接（上限）；加總為計算機做法 |
| D2 | 22 | inferences⁄second ≤ max(joules⁄second) × inferences⁄joules | 功耗上限會限制吞吐。第一版不建模，只顯示峰值功耗。 | 直接 |
| D3 | 23 | inferences⁄joules = operations⁄joules × 1 ⁄ (operations⁄inference)；Energy_total = Energy_data + Energy_MAC；joules⁄operation = α × C × V_DD²（α 切換活動、C 切換電容、V_DD 供電電壓） | 第一版不計算能耗。日後「每 token 能耗」可採 Energy_data + Energy_MAC 的結構：搬移位元組 × pJ⁄byte + FLOPs × pJ⁄FLOP。 | 直接（結構） |
| D4 | 24 | 45 nm 能耗表（pJ）：8b Add 0.03、16b Add 0.05、32b Add 0.1、16b FP Add 0.4、32b FP Add 0.9、8b Multiply 0.2、32b Multiply 3.1、16b FP Multiply 1.1、32b FP Multiply 3.7、32b SRAM Read (8KB) 5、**32b DRAM Read 640**；「Energy consumption is dominated by the data movement」 | 支持 B1 的判斷：LLM decode 主要受資料搬移限制。數值本身不進入計算，因為製程與 HBM 不同。 | 直接（定性） |
| D5 | 25 | operations⁄joules = (EO + UIO)⁄joules × EO⁄(EO + UIO) × 1 ⁄ (EO⁄operations)；「A function of the ability of the hardware to exploit sparsity」 | 同 C2，用於未來的能耗估算。 | 直接 |
| D6 | 229, 230, 231–232, 245 | p.229「Don't Forge[t] Memory System Energy」：伺服器功耗（% of peak）對負載，**Idle 約 47%**，100% 負載約 99–100%，其中 DRAM 約 25%（數值由圖目測）。p.230：「Energy with Corrected Cache Size」。p.231–232：加速器「Report 10~1000x improvements」，但「Inefficient System, Efficient Chip」。p.245「Memory Subsystem = Half Energy」 | 留給未來的功耗／能耗功能：(a) 功耗不與利用率成正比，閒置時約為峰值一半，不可線性內插；(b) 必須計入記憶體能耗，約佔一半；(c) 比較時以系統層級計，不引用只算晶片的效率。第一版不使用。 | 直接（圖表） |

## E. 評估方法

| # | 頁 | 講義重點 | 計算機中的對應 | 強度 |
|---|---|---|---|---|
| E1 | 30, 31, 32 | p.30：Throughput「Number of cores (include utilization along with peak performance)」、「Runtime for running specific DNN models」；Latency「Include batch size used in evaluation」；Energy and Power「Power consumption for running specific DNN models」、「Include external memory access」。p.31 Eyeriss 指標表欄位：Model、Top-5 error、Supported layers、Bits per weight、Bits per input activation、**Batch Size**、Runtime、Power、**Off-chip Access per Image Inference**、Number of Images Tested、「Measured or Simulated: Measured」。p.32：「Without reporting the off-chip bandwidth, one could build a processor with only multipliers and claim low cost, high throughput, high accuracy, and low chip power」 | 結果一律附上同時人數（batch）、所用的 η、權重與 KV 的 dtype，並在計算依據中顯示**每步讀取位元組**（對應 off-chip access per inference）。 | 直接 |
| E2 | 32 | 「All metrics should be reported for fair evaluation of design tradeoffs」；「Are results measured or simulated? On what test data?」 | **資料誠信規則**（spec §2.1）：每個值標明 measured ⁄ derived ⁄ estimate，並附測試條件（校正點的 engine、workload、樣本數）。 | 類比 |
| E3 | 33 | 評估流程：Accuracy → Latency & throughput → Energy & power → Cost | 計算機的判斷順序：能力等級（模型夠不夠用）→ 速度與容量 → 功耗 → 費用（待費率）。講義的 cost 指晶片面積，計算機指租用費率，屬類比。 | 類比 |

## F. 平行切分與歸約

| # | 頁 | 講義原文 | 計算機中的對應 | 強度 |
|---|---|---|---|---|
| F1 | 39 | Recursive GEMM：Case 1 [A1; A2] B = [A1B; A2B]；Case 2 (A1, A2)[B1; B2] = (A1B1 + A2B2)；Case 3 A(B1, B2) = (AB1, AB2) | 三種切法：Case 3 切權重的輸出維度、輸入完整複製、輸出串接 → **column-parallel**（每卡權重 W ⁄ tp，不需歸約）。Case 2 切內積維度、各段產生必須相加的部分和 → **row-parallel + all-reduce**。Case 1 切 token、權重完整複製 → **資料平行**（每個副本存完整權重）。 | 類比 |
| F2 | 112 | 「Across channels (C): Reduction, Synchronization. Across kernels (K): Synchronization. Across image (X or Y): Independent. Broadcast operation; Partitioned memory」；圖：Shared IB → Broadcast → Partitioned KB → Partitioned OB；Shared KB → Broadcast → Partitioned IB → Partitioned OB | 與 F1 相同的三分法，並指出記憶體配置：切 K（輸出）時權重分割、輸入廣播；切 C（輸入）時需要**歸約與同步**；切影像（≈ batch）時彼此獨立，權重共用（每個副本一份完整權重，副本之間不通訊，對應 spec §5.4 的 DP）。FC = R = S = E = F = 1 的 conv，所以適用於線性層。 | 類比（強） |
| F3 | 192, 202, 215, 217, 218 | p.215：「Spatial-K: accumulation dimension → Adder tree/dot product; Systolic accumulation. Spatial-M/N: data reuse dimension → Direct-wiring multicast; Systolic multicast」。p.202：「Partial sums are accumulated horizontally」。p.217／218：Adder Tree、Systolic Accumulation「Applicable to any accumulation dimensions」 | 切累加維度 K 時，**部分和一定要歸約**；歸約後得到完整輸出 tile，所以訊息大小 ∝ **本步 token 數 × hidden × 位元組**，decode（M = B）與 prefill（M = prefill token 數）都一樣。「每層 2 次」來自 Megatron 式 TP（attention 輸出投影與 MLP down 投影各一次 row-parallel），不在講義中。講義的歸約是相鄰 PE 的硬體連線，**沒有時間模型**；α-β 與 ring 2(p−1)⁄p 見 spec §5.4。 | 直接（需要歸約與其大小）；時間模型未涵蓋 |
| F4 | 75, 77, 99 | p.75：「In effect, in the obvious way, each matrix is stored a total of n times」。p.77：「Cannon's method avoids storing each matrix n times」。p.99：「Exploiting spatial reuse at higher levels of the memory hierarchy creates more duplicated data in the hardware」 | 「多個單元都需要同一份資料，就各存一份」的一般原則，可用來**說明** GQA 在 KV 頭數 < tp 時複製 KV 頭、MLA latent 每卡一份。講義談的是晶片內傳遞，不是各卡私有 HBM 的儲存；p.77 也顯示複製取決於 mapping，不是必然。**實際依據是 vLLM**（spec §5.1：v0.32.0 `QKVParallelLinear`、`ModelConfig.get_num_kv_heads`，見 `docs/research/vllm-tp-kv-precision.md` §1；v0.10.0 起規則相同），不可標為 R-LEC。 | 弱 |
| F5 | 206, 209 | p.206：「Mesh Network … For inter-cluster connections」；「All-to-All Network … for intra-cluster connections. Complexity is contained within a cluster」。p.209：「Cluster size can scale up depending on tolerable cost of the all-to-all networks」 | 「TP 不跨越 NVLink 網域」（spec §5.4）的類比：網域內全互連（NVLink switch），網域間用較便宜的網路（IB），只做 PP 或 DP。 | 類比 |
| F6 | 11, 26 | p.11：active PE 的利用率受「Bandwidth and latency of the memory hierarchy and network」影響。p.26：硬體成本包含「off-chip bandwidth」與「Off-chip DRAM, NVLink, etc.」 | 通訊時間同時有延遲（α）與頻寬（β）兩項的定性依據。式子不在講義中。 | 弱 |

## G. 重疊與固定開銷

| # | 頁 | 講義原文 | 計算機中的對應 | 強度 |
|---|---|---|---|---|
| G1 | 225, 226, 227 | p.225：「Double-buffering. Goal: Overlap compute and communication by doubling the SRAM sizes. Producer writes to a buffer while Consumer reads from the other buffer」。p.226：Gemmini PE 的雙緩衝權重暫存器 W_0／W_1。p.227 TPU：「Double-buffered, weight-stationary dataflow」 | 資料傳輸與計算重疊時，每個 tile 時間 = max(傳輸, 計算)；不重疊時為兩者相加（推導）。這是 B1 的 **max()** 在硬體上成立的機制。spec 把 t_comm 放在 max() **之外**相加，等於假設通訊與計算完全不重疊，是**保守**的上界，不是講義的定律（講義的設計目標正是重疊）。 | 直接（機制）；推導（式子） |
| G2 | 73, 86, 114 | p.73：Cannon「Not including the loading which can be done in parallel for a time of 1, this technique is effectively N」。p.86：3×3 weight-stationary 陣列處理單一輸入向量，第 6 步才完成（9 個 MAC 占 9 個 PE × 6 步，由圖讀出）。p.114：「𝓔 ≥ N_vec · N_fma · L_fma」（「Instruction scheduling to saturate the computation pipeline」；符號未在投影片定義） | 管線填充是與工作量無關的固定時間，第一個 tile 的載入也無法被雙緩衝隱藏，是每步 **t_fixed** 的**定性**依據；講義沒有數值或公式。p.114 也說明工作量太小時無法達到峰值，η_compute 在小 B 偏低。 | 弱（t_fixed）；類比（η） |

## 與計算機假設的矛盾或待修正處

以下是講義推得、計算機目前做錯或漏掉的地方。程式位置已對照 2026-10-20 的原始碼。

> **2026-10-20 處理狀態**：第 1–4 點與第 7 點已修正（TTFT 頻寬項與 TP 通訊、all-reduce 訊息含 prefill token、t_fixed 改為校正設定 `tFixedSec`、引用標記），見 spec §5.2–§5.4 的「審查 L1–L5」補充；以下行號是修正前的位置。第 5 點仍為已知簡化，第 6 點的換算本來就正確。

1. **TTFT 沒有頻寬項。**
   - 講義：B1（p.14）是 min()，任何計算都受資料傳送限制；B9（p.239）指出權重至少要從最底層讀一次。所以 prefill 時間 ≥ 權重位元組 ⁄ (BW × η_bw)。
   - 程式：`packages/core/src/timing.ts` `ttftSec`（L114–118）只有算力項；spec §5.3 的 prefill 公式也一樣。
   - 影響：快取命中率高（Agent 預設約 95%）時，新 token 很少，prefill 可能變成頻寬受限。示意：70B FP8、H200 8 卡、約 100 個新 token，若 η_bw = 0.8、η_compute = 0.5，讀一次權重約 2.3 ms，計算約 1.8 ms，TTFT 會被低估。
   - 建議：TTFT = max(算力時間, 讀取位元組 ⁄ (BW × η_bw))。
2. **All-reduce 訊息漏掉 prefill 干擾的 token。**
   - 講義：F3（p.202、215）歸約量 ∝ 本步 token 數 × hidden。
   - 程式：`timing.ts` `decodeStep` L100–105 以 `B * m.hidden * 2` 計算；同一步的 max(0, B − 1) × newTok ⁄ out 個 prefill token 也經過同樣的 row-parallel 歸約，訊息應為 (B + prefill token 數) × hidden × 位元組。
   - 影響：低估通訊時間；在 NVLink 頻寬下短 chunk 影響小，長 prompt 時不可忽略。
3. **TP > 1 時 TTFT 沒有 all-reduce。**
   - 講義：F2、F3（p.112、215）切累加維度就需要歸約，與 prefill 或 decode 無關。
   - 程式：`timing.ts` `ttftSec` 沒有通訊項。tp > 1 時 prefill 需要 2 × L 次 all-reduce，每次 newTok × hidden × 2 位元組；延遲項就有 2 × L 次（L = 80 時為 160 次）。
4. **spec §5.2 的 t_fixed 沒有實作。**
   - 講義：G2（p.73、86）只有定性依據。
   - 程式：`timing.ts` `decodeStep` L106 `stepSec = Math.max(bwSec, computeSec) + commSec`，沒有 t_fixed。spec 與程式不一致，需擇一修正（實作，或從 spec 移除並說明由 η 吸收）。
5. **η 只依平台的校正設定，不依模型（已知簡化）。**
   - 講義：A7（p.18）把 Number of active PEs 與 Utilization of active PEs 標為 HW + Model；p.15「Wide range of layer shapes → Poor utilization of PEs」。
   - 程式：`packages/core/src/api.ts` L195 `lookup(bundle.calibration, p.calibration, ...)`，L249–250 取 `etaBw`／`etaCompute`；η 由「平台 × 引擎」決定（spec §5.2），與模型無關。
   - 處理：記為已知簡化。spec 的校正範例已限定「大型 dense 模型」，日後可改為依模型類別（dense ⁄ MoE ⁄ MLA）分設。
6. **單位：每元素與每位元組。**
   - 講義：p.36、38、44 以元素計，p.14 以 byte 計。
   - 程式：`timing.ts` L92–95 以 `bytesPerParam`（`weightsReadBytes`）與 `kvBytesPerElem` 換算為位元組，計算本身正確。引用 B4、B7 的強度數值時，計算依據的文字必須寫明除以每元素位元組。
7. **引用標記需調整（不影響數值）。**
   - `api.ts` L211–212 把 η_bw 的出處標為 `B1`；η_bw 不在講義中（A4、B1），應改標計算機補充與校正設定。
   - `api.ts` L1032 MoE 期望專家比例標為 `[R-LEC B3, B5]`；B3、B5 只支持「每步讀一次、從 HBM 讀」，E(1 − (1 − k⁄E)^B) 應標 spec §5.2（`model-math.ts` L80 已如此標示）。
   - `api.ts` L1030 decode 單步公式含「+ 通訊時間」卻只標 `[R-LEC B1, B3, A4, C1]`；通訊項應另標 spec §5.4（並可加 F3、G1）。

## 講義未涵蓋、改由其他出處支撐的部分

以下內容講義沒有談到，或只有類比，依據另見 spec §5 與 `docs/research/`：

- **KV cache 與其 TP 複製**：講義沒有注意力頭或 KV 的內容。max(n_kv_heads, tp) 與 MLA × tp 依 vLLM v0.32.0 `ModelConfig.get_num_kv_heads` 與 `QKVParallelLinear`，sliding window 層的穩態用量、進行中 chunk 的預留與啟動上限依 `SlidingWindowManager` 與 `SlidingWindowSpec`，見 `docs/research/vllm-tp-kv-precision.md` §1–§3 與 spec §5.1；F4 只是類比說明。
- **MLA**：latent 大小 L × (kv_lora_rank + qk_rope_head_dim) 與每卡一份，見 spec §5.1。
- **MoE 專家觸發**：E × (1 − (1 − k⁄E)^B)。講義的 filter reuse 假設每個樣本用同一組權重，沒有路由；B4、B9 只說明每個專家的權重由分到它的 token 分攤。見 spec §5.2。
- **All-reduce 演算法與 α-β 模型**：ring 2(p−1)⁄p × 訊息 ⁄ 頻寬 + 延遲、每層 2 次，見 spec §5.4 與 [R-HW]。講義只支持「需要歸約」與「訊息大小」（F3）。
- **embedding／lm_head 精度**：vLLM 的 FP8、AWQ、MXFP4 只量化 Linear 與 MoE 層，embedding 與 lm_head 維持 16-bit，見 spec §5.1。講義只有「權重與 activation 位元數分列」（C3）。
- **TP 不能整除注意力頭數**：vLLM 直接拒絕這種配置，所以計算機不列入合法 TP（`packages/core/src/solve.ts` L62–81），而不是模擬閒置的卡。講義所有 tiling 都假設整除（p.144、150、153），沒有餘數處理。
- **推論引擎行為**：prefill 與 decode 的分工、chunked prefill 干擾 max(0, B − 1) × newTok ⁄ out、prefix cache、CUDA graphs 與固定記憶體開銷，見 spec §5.1、§5.3 與 `docs/research/prior-art-calculators.md`。
- **每 token FLOPs 的注意力項**：4 × heads × headDim × context（逐層組加總）是標準推導，見 spec §5.2（Ruling R33），計算核心的測試以手算值驗證。線性層項 2 × 啟用參數則有講義依據（B8）。

## 投影片本身的錯誤（引用時避開）

- p.7「can be directly derivable」，依範例應為 cannot。
- p.17「requires addition hardware」，應為 additional。
- p.40 Blocked GEMM 虛擬碼寫成 A(i,j)、B(i,j)，應為 A(i,k)、B(k,j)；該頁沒有流量公式。
- p.101 文字稱輸入通道為 N，圖標為 C（p.121 的 N 是 batch）。
- p.103「Worse Case」，應為 Worst Case。
- p.124 OS 迴圈寫 `range(S)`，應為 `range(R)`。
- p.138 `e = e1*e0 + e0`、p.139 `r = r1*r0 + r0` 與「spatia_for」，應為 `e1*E0`、`r1*R0`。
- p.147 標題「(OS)」，內容是 IS。
- p.177「RW」，應為 RS（Row Stationary）。
- p.190 標題「Multiple Filters – Fmap Reuse」（與 p.191 同標題）：p.190 的圖其實是 Multiple Fmaps – Filter Reuse；p.191 的圖才與標題相符。
- p.212 標題「Depth-wise CONV Layer」，內容是 FC 層的情況。
