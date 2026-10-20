# NVIDIA GPU 與國網（NCHC）系統規格查證筆記

- 查證日期：2026-10-19
- 用途：推論算力計算機的硬體資料來源
- 原則：每個數字都附來源；未查證的標 **UNVERIFIED**；來源互相矛盾的標 **衝突**

## 重點結論（與原本認知的差異）

1. **nano5（晶創25）不只有 H100**：官方列出 **21 台 H100 加上 16 台 H200**，每台都是 8 GPU [10]。H200 節點透過 Slurm 分區 `normal2` 使用 [19]。
2. **nano4（晶創26）的 Blackwell 是 GB200 NVL72，不是 HGX B200**：
   - 2 個機櫃、36 個運算節點、144 張 GPU [14][16]。
   - 每節點 4 GPU 加 2 顆 Grace CPU。這是推算值（72 GPU ÷ 每櫃 18 節點），和標準 GB200 NVL72 運算抽屜一致，官方文件沒有直接寫出每節點數量。
   - 一整個機櫃的 72 張 GPU 共用同一個 NVLink 網域。Slurm 分區 `gb200-r1` 和 `gb200-r2` 的工作不會跨機櫃 [20]。
   - 計算時應使用 **GB200 的單 GPU 規格**，不能用 HGX B200 的。
   - nano4 另有 **220 台 HGX H200**，每台 8 GPU，共 1,760 GPU [14][15]。

## A. GPU 單卡規格（SXM 版本）

NVIDIA 官網標的 H100 和 H200 tensor 數字都含稀疏加速（註腳寫「With sparsity」），所以 **dense 值 = 標示值 ÷ 2**。HGX、DGX 和 GB200 頁面也註明「Dense is one-half sparse spec shown」。

| 規格 | H100 SXM5 80GB | H200 SXM 141GB | HGX B200（1000 W） | GB200 Blackwell GPU（nano4） |
|---|---|---|---|---|
| FP64 / FP64 Tensor（TFLOPS） | 34 / 67 [1] | 34 / 67 [2] | 37 / 37 [3][4] | 40（每顆 superchip 80 ÷ 2）[5] |
| TF32 dense（TFLOPS） | 494.5（稀疏 989）[1] | 494.5 [2] | 1,125 [3][4] | 2,500 [5] |
| BF16/FP16 dense（TFLOPS） | 989.5（稀疏 1,979）[1] | 989.5 [2] | 2,250 [3][4] | 2,500 [5] |
| FP8 dense（TFLOPS） | 1,979（稀疏 3,958）[1] | 1,979 [2] | 4,500 [3][4] | 5,000 [5] |
| INT8 dense（TOPS） | 1,979 [1] | 1,979 [2] | 4,500 [3][4] | 5,000 [5] |
| FP4 dense（TFLOPS） | 不支援 | 不支援 | 9,000（每 8 GPU 72 PF dense）[3][6] | 10,000（每顆 superchip 20 PF dense ÷ 2）[5] |
| HBM 容量 | 80 GB HBM3 [1] | 141 GB HBM3e [2] | 180 GB HBM3e [4][6] | 186 GB（13.4 TB ÷ 72）[5] |
| 記憶體頻寬 | 3.35 TB/s [1] | 4.8 TB/s [2] | **衝突**：8 TB/s [6]，Lenovo 寫 7.7 TB/s [4] | 8 TB/s（576 TB/s ÷ 72）[5] |
| NVLink | 第 4 代，900 GB/s 雙向（18 條 × 50 GB/s）[7] | 第 4 代，900 GB/s [2] | 第 5 代，1.8 TB/s [3]。Lenovo 寫 900 GB/s，可能是單向數字 [4] | 第 5 代，1.8 TB/s；72 GPU 共用一個 NVLink 網域 [5] |
| NVSwitch（8 GPU 主機板） | 4 顆第 3 代 NVSwitch，3.6 TB/s 對分頻寬 [8] | 同 H100 [8] | 2 顆 NVSwitch（NVLink 5），合計 14.4 TB/s [3][6] | NVLink Switch tray，每櫃 130 TB/s [5] |
| PCIe | Gen5，128 GB/s [1] | Gen5，128 GB/s [2] | Gen5，128 GB/s [4] | UNVERIFIED |
| TDP | 最高 700 W [1] | 最高 700 W [2] | 每 GPU 1,000 W [4]；DGX B200 整機約 14.3 kW [6] | UNVERIFIED |
| L2 快取 | 50 MB [7] | UNVERIFIED（同一顆 GH100 晶片，推測 50 MB） | 126 MB [9] | 126 MB [9] |

第三方交叉核對（glennklockwood.com，引用 NVIDIA Blackwell 技術簡報）：

- 1000 W 的 HGX B200 是 37 / 1,125 / 2,250 / 4,500 / 9,000，和上表一致。
- 1200 W 版本是 45 / 1,250 / 2,500 / 5,000 / 10,000。

## B. 國網系統

| 項目 | nano5（晶創25） | nano4（晶創26）H200 | nano4（晶創26）GB200 |
|---|---|---|---|
| GPU | H100 SXM5 80GB 與 H200 [10][11][12] | H200 SXM5 141GB [13][14][15] | GB200 NVL72 [13][15] |
| 每節點 GPU 數 | 8 [11] | 8 [14][15] | 4（推算值）[16] |
| 節點數 | H100 21 台、H200 16 台 [10] | 220 台（1,760 GPU）[14][15] | 2 櫃，36 節點，144 GPU [14][16] |
| CPU | 2 × Xeon Platinum 8480+/8480L/8480CL [10][11] | 2 × Xeon Platinum 8480+，56 核 [14][16] | 每櫃 36 顆 Grace [5][14]；國網新聞稿寫 72 顆（**衝突**）[13] |
| 每節點系統記憶體 | 2 TB [10][11] | 2 TB [14][15] | UNVERIFIED |
| 節點間網路 | IB NDR 8 × 400 Gb/s 運算網路，加 2 × 200 Gb/s 儲存網路 [10][11] | 8 × IB NDR 400 Gb/s [14][16] | NDR 400 Gb/s；跨櫃連線 72 × 400 Gbps [16]；每節點 HCA 數 UNVERIFIED |
| 儲存 | 未載明 | 晶創26 共 25 PB [13][15] | 共用 25 PB |
| TOP500 | 「Nano 5 – DGX H100」，Rmax 13.06 PF，Rpeak 19.01 PF；排名 06/2025 第 118、11/2025 第 135、06/2026 第 155 [12] | 11/2025 第 29 名，Rmax 81.55 PF，2.214 MW [13][17]；DCD 報導寫第 33 名（**衝突**）[18] | 未提交 |
| Slurm 分區 | dev / normal / 4nodes 是 H100；normal2 是 H200 [19] | dev、8gpus、16gpus、32gpus、64gpus [20] | gb200-dev、gb200-r1、gb200-r2 [20] |

nano4 於 2026-06-01 啟用，7 月開始收費運作 [21]。

## C. 延遲（大多 UNVERIFIED，NVIDIA 沒有公開官方數字）

| 項目 | 數值 | 來源與狀態 |
|---|---|---|
| Quantum-2 NDR switch，port-to-port | 130 ns | 第三方經銷商（gpusmith.com），UNVERIFIED |
| Quantum-2 cut-through switch | 約 330 ns | 第三方（yobitel.com），UNVERIFIED |
| ConnectX-7 / NDR 端到端 | 查無公開值 | UNVERIFIED。業界常引用 1–2 µs，但沒有來源 |
| H100 GPU 間小訊息 ping-pong 往返 | 16.0–24.3 µs（依 NCCL、NVSHMEM 實作而異） | arXiv 2511.15076 [23]，在 EOS 叢集量測 |
| GB200 NVLink：L2 往返 / 遠端寫入 | 0.306 µs / 0.792 µs；AllReduce 理論下限 1.404 µs | arXiv 2607.16100 [24] |
| GB200 4 GPU 小訊息 AllReduce | NCCL ring 11.0 µs；論文的低延遲 kernel 2.37 µs | [24] |
| H100 NVSwitch P2P | 查無可信實測值 | UNVERIFIED |

**建模建議**：計算機裡的延遲參數一律標示為「實測或第三方來源」，並允許調整。

## 來源

- [1] https://www.nvidia.com/en-us/data-center/h100/
- [2] https://www.nvidia.com/en-us/data-center/h200/
- [3] https://www.nvidia.com/en-us/data-center/hgx/
- [4] https://lenovopress.lenovo.com/lp2226-thinksystem-nvidia-b200-180gb-1000w-gpu
- [5] https://www.nvidia.com/en-us/data-center/gb200-nvl72/
- [6] https://www.nvidia.com/en-us/data-center/dgx-b200/
- [7] https://docs.nvidia.com/cuda/hopper-tuning-guide/index.html
- [8] https://developer.nvidia.com/blog/introducing-nvidia-hgx-h100-an-accelerated-server-platform-for-ai-and-high-performance-computing
- [9] https://docs.nvidia.com/cuda/blackwell-tuning-guide/index.html ; https://old.chipsandcheese.com/?p=37649
- [10] https://www.nchc.org.tw/Page?itemid=58
- [11] https://iservice.nchc.org.tw/nchc_service/nchc_service_f1-2.php
- [12] https://top500.org/system/180384 ; https://www.top500.org/site/51068
- [13] https://www.nchc.org.tw/Message/Print/4029?mid=92
- [14] https://man.twcc.ai/@nano4-manual/SJuKzVlwbx
- [15] https://iservice.nchc.org.tw/nchc_service/nchc_service_nano4.php
- [16] https://man.twcc.ai/@nano4-manual/SyaY-6T8bg
- [17] https://servers.asus.com/stories/NCHC-Nano4-ASUS-Taiwan-Liquid-Cooled-AI-Supercomputer ; https://press.asus.com/news/press-releases/asus-nchc-taiwan-ai-supercomputer/
- [18] https://www.datacenterdynamics.com/en/news/taiwans-new-nano4-supercomputer-comes-online/
- [19] https://man.twcc.ai/aPiCU8VXS7SZgFJBOoSqBQ
- [20] https://man.twcc.ai/@nano4-manual/SJM_FuxDWe
- [21] https://www.nchc.org.tw/Message/Print/4999?mid=92
- [22] https://www.nvidia.com/en-us/networking/quantum2/
- [23] https://arxiv.org/html/2511.15076
- [24] https://arxiv.org/html/2607.16100

輔助來源：

- DGX H100/H200 使用手冊：https://docs.nvidia.com/dgx/dgxh100-user-guide/introduction-to-dgxh100.html
- B200 第三方整理：https://glennklockwood.com/garden/processors/B200
- Switch 延遲：https://gpusmith.com/hardware/networking/nvidia-quantum-2-qm9700 ; https://yobitel.com/knowledge-base/infiniband-ndr
