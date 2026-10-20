<div align="center">

# 🧮 inference-deployment-calculator

**國網推論算力計算機：這個推論工作負載，在國網每一種機台上要幾張卡？**

![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/node-24-5FA04E?logo=nodedotjs&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-12.9.1-F69220?logo=pnpm&logoColor=white)
![Tests](https://img.shields.io/badge/tests-461%20passed-brightgreen?logo=vitest&logoColor=white)
![Models](https://img.shields.io/badge/models-14-2A6DB2)
![Status](https://img.shields.io/badge/status-core%20done%20%C2%B7%20web%20%26%20MCP%20pending-orange)

</div>

---

輸入模型、人數與任務類型，得到每個平台（H100、H200、GB200、Mac、DGX Spark）需要的 GPU 數、每人速度與首字時間。每個數字都附出處，並附上可在機台上執行的驗證指令。

> [!WARNING]
> H100／H200 以 SemiAnalysis InferenceX 的公開實測校正（每步固定開銷與首字開銷，Ruling R41），decode 大致在 ±25% 內，首字時間誤差仍大；GB200 沒有可用的公開實測，數字是外推的估算。全部尚待國網實測校正。

## 🧰 功能

| 函式 | 回答的問題 |
| --- | --- |
| **`estimateRequirements`** | 這個負載在每個平台各需要幾張卡？ |
| `estimateCapacity` | 這些卡最多能服務多少人？ |
| `findFeasibleModels` | 這些卡能跑哪些模型？ |
| `explain` | 這個數字用了哪些數值、出處與公式？ |
| `verifyCommand` | 要怎麼在機台上驗證？ |

範例：200 人用 gpt-oss-120b 聊天（實際輸出摘錄）

| 平台 | GPU 數 | 每人速度 | 首字時間 |
| --- | --- | --- | --- |
| H200 nano4 | 1 | 27.0 tok/s | 0.11 s |
| H100 nano5 | 2 | 44.7 tok/s | 0.10 s |
| GB200 nano4 | 1 | 60.9 tok/s | 0.09 s |
| Mac Studio M5 Ultra | 12 台 | 21.6 tok/s | 0.17 s |
| Mac mini M5 Pro 64GB | ✗ 權重 65 GB，可用 48 GB | | |

## 🚀 快速開始

```bash
corepack enable
pnpm install
pnpm data:build    # 驗證 config/，輸出 packages/data/dist/bundle.json
pnpm test
pnpm calibrate     # 與公開實測的誤差報告
```

網站與 MCP 尚未開始；[docs/prototypes/](docs/prototypes/) 裡的是靜態 UI 原型，沒有接上計算核心。

## 🗺️ 架構

```mermaid
flowchart LR
    HF["Hugging Face"]
    CFG["config/*.yaml"]
    DATA["packages/data<br/>驗證 · 出處"]
    BUNDLE[("bundle.json")]
    CORE["packages/core<br/>計算 · 驗證指令"]
    APPS["apps/web · apps/mcp<br/>（尚未開始）"]

    HF -- "data:import" --> CFG
    CFG -- "data:build" --> DATA
    DATA --> BUNDLE --> CORE
    CORE -.-> APPS

    style APPS stroke-dasharray: 5 5
```

YAML 是唯一的資料來源，程式碼不寫死任何硬體、模型或負載數值。

## 🛡️ 規則

由 `pnpm data:build` 強制執行，違反就建置失敗：

- **每個數值都要有出處**：標明 `official`／`measured`／`derived`／`estimate`，並附來源、公式或推估依據。

## 🎯 準確度

| 平台 | 狀態 |
| --- | --- |
| Mac Studio M5 Ultra | ⚠️ decode +0.5%（η_bw 由此點推得，屬循環驗證）；首字時間 +33.3%（超出 ±25%） |
| DGX Spark | ⬜ 沒有有效比對點 |
| H100 · H200 | ⚠️ InferenceX（vLLM v0.10.2–v0.22.0）36 個 validate 點：decode 18 點中 16 點在 ±25% 內（平均絕對誤差 15%；gpt-oss 8k 輸入 c=32／64 高估 +35%／+65%）；首字時間 18 點中 3 點（平均絕對誤差 54%，TP ≥ 2 的短 prompt 高估、長 prompt 與高併發低估）。fit 點 4 個（H200 TP=1 1k/1k c=4） |
| GB200 | ⬜ 沒有可用的公開實測（等待國網實測） |

## ⚙️ 設定

所有數值在 [config/](config/)：硬體、平台、量化、負載、校正、出處，以及由 HF 匯入的 [models/](config/models/)。新增模型：

```bash
pnpm data:import <owner/repo> --developer <名稱> --country <ISO2>
```

## 📖 文件

- [設計文件](docs/superpowers/specs/2026-10-19-inference-calculator-design.md)：計算模型、資料規則
- [實作計畫](docs/superpowers/plans/2026-10-19-core-and-config.md)
- [研究筆記](docs/research/)
