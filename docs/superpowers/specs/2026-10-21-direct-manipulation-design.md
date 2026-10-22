# 網站 v8：直接操作、試算區與自訂（設計文件）

日期：2026-10-21（依使用者核可的 demo v8 改寫；取代本檔先前的草稿）。這份文件補充 `2026-10-19-inference-calculator-design.md`（下稱「主設計」）。主設計的規則（§2.1 資料誠信、§2.2 模型限制、§5 計算模型、§8.2 視覺準則）全部繼續適用；本文寫新增與改變的部分，並取代主設計 §8.3.3 v6 中與本文衝突的版面細節。

**視覺規格**：`docs/prototypes/calculator-demo-v8.html`（使用者 2026-10-21 核可，commit `6e00bce`，下稱「demo」）。demo 的數字是假的；版面、文案、互動與動畫以 demo 為準，數字一律來自 core。

## 1. 為什麼

第二階段網站完成後，使用者指出：

- 不能自己調整卡數，只能看到建議值（主設計 §8.1「直接操作」漏做）。
- 「我需要多少／我已有」模式切換讓每個人都要先想自己是哪一種。
- 展開／收合手刻、沒有動畫、Mac 圖示是藍色、沙漏用 emoji、機器圖示超出頁面、「推估」popover 塞滿全部內容而超出頁面。
- 計算機只回答「要幾張卡」，但真實使用者的問題更多（第 2 節）。

## 2. 目標：回答使用者的所有問題，而不變複雜

不能假設使用者都拿得到建議數量。每一類問題都要有自然找得到的入口（「入口」欄）：

| 類別 | 問題 | 入口 |
|---|---|---|
| 正向 | N 人要幾張卡；只知道總人數時同時大概幾人 | 句子 → 答案行；點人數欄 →「只知道總人數？」→ 漏斗 Drawer |
| 反向 | 我的卡最多撐幾人；給 N 人用每人多快、首字多久 | 該平台列的卡數控制 → 容量條、速度行 |
| 加減卡 | 多給卡快多少、何時不再變快、少給多慢、最少幾張勉強可用 | 卡數控制；試算區「卡數 → 每人速度」曲線（可點選設定卡數） |
| 預算有限 | 只有 X 張：能撐幾人、要放寬什麼 | 卡數少於建議時的建議動作（較低精度、較慢速度、較少人數、較小模型、改回建議） |
| 預算充裕 | 多出的卡多服務幾人、能否改跑更大的模型 | 卡數多於建議時的建議動作 |
| 取捨 | 精度、模型大小、上下文 vs 人數、TP 切法 vs 副本數 | 句子的精度／模型；自訂工作（上下文長度）；試算區「切法」選單 |
| 比較 | 平台之間；同機台不同模型／精度／用途；誰過關、到幾人 | 平台列「比較」勾選 → 頁面下方比較卡片與疊圖（v9，見 `2026-10-22-compare-v9-design.md`） |
| 規劃 | 人數成長到多少要加機器 | 試算區「人數 → 每人速度」曲線（目前人數、上限） |
| 自訂 | 硬體、模型、工作負載、速度 | 「找不到你的硬體？新增硬體」；模型搜尋找不到；工作／速度選單「自訂…」 |
| 信任 | 為什麼要這麼多、出處、怎麼驗證、準不準 | 使用率條與記憶體組成；依據（Modal）；驗證指令（Drawer）；頁尾準確度（Drawer） |
| 輸出 | 引用段落、分享連結 | 答案行文字按鈕：引用（Modal）、分享 |
| 誠實標示 | 費用、尾端延遲 | 頁尾：「費用：尚未包含（缺國網費率）」「尾端延遲（P95）：尚未估算」，hover 看說明 |

不變複雜的規則：一句完整句子當輸入（不可縮成「·」欄位）、一行答案、每平台一列，其他一律需要時才出現。沒有「進階模式」，沒有模式切換。

## 3. 設計準則（使用者逐條指定）

### 3.1 入口放在需要的時刻

- 拿掉「我需要多少／我已有」模式切換。已有硬體的人在自己那一列調卡數，就是反向查詢。
- 新增硬體：平台列表最後一列下方的虛線按鈕「找不到你的硬體？新增硬體」（`PlusOutlined`）。新增後是一般的一列，標「自訂」，可編輯、刪除、調卡數、展開、加入比較。
- 自訂模型：模型搜尋的 `notFoundContent` 顯示「找不到這個模型？」與「從 Hugging Face 匯入」「手動輸入架構」；搜尋字串像 `owner/name` 時按鈕寫「匯入 owner/name」並直接帶入。
- 自訂工作／速度：選單最後一項「自訂…」，說明「以上都不符合？自己設定…」。
- 人數漏斗：只在人數欄聚焦時，下方 popover 出現「只知道總人數？換算同時人數」。
- 加入比較：v9 起改為每個平台列上的「比較」勾選（見 `2026-10-22-compare-v9-design.md`）；試算區不再有按鈕。
- 依據、引用、分享：答案行右側的文字按鈕。

### 3.2 依使用頻率決定幾步看得到

| 頻率 | 元素 | 打開方式 |
|---|---|---|
| 每次都用 | 句子空格、答案、每列卡數 | 直接顯示 |
| 選擇時 | 下拉選項說明 | 選單打開時只對目前（游標或已選）選項顯示；`(hover: none)` 時列在每個選項下方 |
| 偶爾 | 推估摘錄、不可行原因、圖示圖例、容量條／使用率條意思、切法說明、功耗說明、排隊原因、打字示範說明、頁尾的費用與 P95 說明 | hover popover（觸控點擊、鍵盤焦點也可；沿用第二階段 `Explain`），內容短 |
| 稽核 | 全部依據、出處、驗證指令、準確度、推估完整清單 | 多一步：「查看全部 →」或明確按鈕 |

既有 hover popover 維持 hover（使用者明確指定，不可改成點擊）。

### 3.3 說明框不可擋住視野

- 「推估」popover 只列前 3 項（每項一行：狀態標記 + 名稱，寬 300 px，過長截斷）與「查看全部 N 項 →」。點「查看全部」時 popover 關閉。
- 「依據」與「引用」都用 **Modal**（使用者 2026-10-21 指定：兩者並排，UX 要一致）。依據 Modal 最上方用 `Segmented` 篩選「推估與未查證（N）」／「全部（N）」，從「推估」進來預設前者，從「依據」按鈕進來預設後者；內容區最高 70vh、內部捲動。
- 其他清單與多欄位表單（驗證指令、準確度、漏斗、自訂工作、自訂速度、HF 匯入、手動模型、新增／編輯硬體）用 Drawer。

### 3.4 元件與圖示

- antd 6 元件；列的展開用 `Collapse`（accordion，`collapsible="header"`，只有平台名稱能點開；不可行的列 `collapsible="disabled"`、不顯示箭頭）。列上的輸入與說明在 header 的 `extra`，不可被包進展開按鈕。
- 圖示只用 `@ant-design/icons`：等待首字 `HourglassOutlined`（spin）、不可行 `CloseCircleOutlined`、可行 `CheckCircleOutlined`、建議動作 `BulbOutlined`、加入比較 `PushpinOutlined`、驗證指令 `CodeOutlined`、功耗 `ThunderboltOutlined`。不可用 emoji 或符號當圖示（文案中的「→」可保留）。
- 樣式選擇器只作用在最外層平台列（`.rows > .ant-collapse-item > .ant-collapse-header`），不可漏到試算區內的巢狀 Collapse（demo 修過的 bug）。

### 3.5 機器圖示

- GPU 平台：每個 node 一個直立方塊（12 × 22，圓角 2），`colorPrimary`；未滿一個 node 只填滿用到的比例。
- Mac／DGX Spark（以台計）：每台一個橫向方塊（20 × 13，圓角 2），`colorTextTertiary`（灰）。
- 實心 = 預期；虛線外框（`3 2`）= 保守估計多出的部分。調整過卡數的列不畫保守（保守值是建議值的屬性）。
- 放不下時：前 k 個方塊、省略號、後 k 個方塊維持一行，下方大括號從頭跨到尾，中央寫「× 10 node・80 張」（Mac：「× 20 台」），保守不同時加「（保守 96）」。k 依 `ResizeObserver` 量到的容器寬度決定；放得下時不畫括號。
- 列上其他元素都可換行；390、768、1024、1440 px，搭配 60 個 node、20 台 Mac，`scrollWidth <= innerWidth`。
- 圖示 hover 說明：GPU「每個方塊 = 1 個 node（N 張 GPU）；未滿一個 node 時只填滿用到的比例；實心為預期，虛線為保守估計多出的部分」；Mac「每個方塊 = 1 台；實心為預期需要，虛線為保守估計多出的台數」。

### 3.6 動畫

- 一組 motion token：400 ms、ease-out cubic（`cubic-bezier(0.215, 0.61, 0.355, 1)`）。antd 透過 `ConfigProvider theme.token`（`motionDurationMid`、`motionDurationSlow` = `0.4s`，`motionDurationFast` = `0.2s`，`motionEaseOut`、`motionEaseInOut`）；D3 用 `TRANSITION_MS` 與 `easeCubicOut`；CSS 過渡用同一組 CSS 變數。`prefers-reduced-motion: reduce` → 0。
- 同一次輸入造成的變化同時開始、同時結束，不錯開；快速連續輸入從目前畫面位置接續。
- 因果動畫：

| 互動 | 怎麼動 |
|---|---|
| 改人數、工作、模型、精度、速度 | 答案大字與每列建議卡數從舊值滾動到新值；機器圖示長出／縮回；容量條伸縮 |
| 最佳方案換列 | 左側色條與底色滑到新的列（FLIP：一個絕對定位的標記以 `top`／`height` 過渡） |
| 可行 ↔ 不可行 | 內容縮回淡出、原因淡入，列高平滑變化 |
| 展開／收合 | `Collapse` 高度動畫，下方各列平滑位移 |
| 調整卡數、套用建議動作、點曲線設卡數、改切法 | 該列圖示、速度、首字、容量條、試算區（使用率條、記憶體條 KV 格一格格長出、曲線上的點）同步過渡；打字示範從目前進度以新速度接續，不重置 |
| 調整過的列多出的速度行 | 淡入並平滑撐開（`grid-template-rows: 0fr → 1fr`） |
| Popover、選單、Drawer、Modal、訊息、標記 | antd 內建 motion |

- 動畫必須在真實瀏覽器驗證（Playwright 逐格截圖 0／100／200／400 ms）。

### 3.7 其他

- 深色模式跟隨系統；body 背景與文字色同步。
- 手機 390 px：可觸控、無橫向捲動、選項說明直接顯示。
- 頁首右側「中文／English」`Segmented`。
- 主畫面用「張」「台」「人」「秒」「字/秒」，工程單位只在說明與依據裡。
- 圖表一律有座標軸刻度數值、格線與含單位的軸標題（使用者 2026-10-21 指出 demo 缺 Y 值與單位）。
- 切法用白話：「每 4 張卡合跑一份模型，共 2 份」「每張卡各跑一份模型，共 N 份」「每台各跑一份模型，共 N 份」，不用「副本」。hover 說明：「一份模型可以用幾張卡合起來跑（張量平行），也可以複製成好幾份，各自服務不同的使用者。合跑的卡越多，每人越快；份數越多，能同時服務的人越多。」

## 4. 畫面結構

1. **頁首**：標題、語言切換。
2. **句子**：「同時最多有 `[15]` 人會使用，做 `[研究助理 ▾]` 任務，模型用 `[Llama-3.3-70B ▾]`，模型精度用 `[FP8 ▾]`，希望回應速度 `[流暢 ▾]`」。
   - 模型選單頂端：「推估（參考用）這類任務建議：<workload.tierNote>」。
   - 模型選項說明：有某一列調過卡數時，「在你的 8 張 H200 上：每人 41 字/秒」（未達標加「（未達標）」）或「你的 8 張 H200 放不下」；否則「可在 X / Y 種機台執行」。
3. **答案行**：最佳國網平台「H200 × 4 張 nano4」＋小字「保守 × 5 張」；國網全部不可行時「國網機台都不可行」＋「可嘗試較小的模型、較低精度或放寬速度」。旁邊「推估」標記（`hasEstimate` 時）、「自訂」標記（`hasUser` 時）；右側文字按鈕依據、引用、分享。答案行永遠是建議值，不跟著調整改變。
4. **平台列表**（`Collapse` ghost accordion，bundle 順序；第一個 `group: self` 前有「自建」分隔線；自訂硬體接在最後；最後是新增硬體按鈕）。每列 header：
   - 名稱／型號（可點開）；自訂列加「自訂」標記與編輯、刪除按鈕。
   - 機器圖示（3.5）。
   - 卡數控制：「建議」按鈕（預設選取）＋ `InputNumber`（1～100,000，單位張或台）。調整後「建議」變未選取，按下回到建議值。
   - 容量條：「同時 15 / 21 人」，目前人數超過上限時紅色。
   - 調整過的列多一行：「✓／✗ 每人 41 字/秒・首字 0.5 秒（原因）　建議 4 張：27 字/秒」。
   - 不可行的列：名稱灰色 + 紅色原因標記（hover 看 detail），不能展開。
   - 輸入條件（人數、工作、模型、精度、速度）一改變，所有手動卡數與切法回到建議值。
5. **試算區（展開一列）**——不用 Tabs，一個畫面看完（使用者指定）：
   - 頂行：「4 張 H200・15 人同時使用・每 2 張卡合跑一份模型，共 2 份」＋ 右側「加入比較」。
   - 第 1 列（寬螢幕左右兩欄，窄螢幕堆疊）：**體驗**｜**原因**。
     - 體驗：打字示範（`HourglassOutlined` 等首字，再以每人速度出字）；每人速度（目標）、首字（上限）、最多同時人數；建議動作按鈕。
       - 未達標：「改用 INT4：每人 25 字/秒」「速度改為可接受」「人數降到 6」「改用 gpt-oss-20b」「改回建議的 4 張」。
       - 卡數多於建議且達標：「還能再多 20 人」「可改跑更大的模型 Mistral Medium 3.5（128 B）」（以參數量排序；不宣稱「更強」，因為設定檔沒有模型能力等級的資料）。
     - 原因：四根使用率條（記憶體、頻寬、算力、首字；最滿的標紅；`Progress status="normal"`）；記憶體組成條（模型、每人 KV 一格、剩餘；「一份模型所用的卡」）；切法選單（所有合法切法，各附速度、首字、人數上限，標「（建議）」）；峰值功耗（未查證時「功耗未查證」，hover 看原因）。
   - 第 2 列：兩張曲線並排（窄螢幕堆疊），背景依速度分流暢／可接受／卡頓三區（分界取自 `speedPresets`）：
     - 「卡數 → 每人速度」：橫軸 GPU 張數（或機器台數），範圍 1 到 max(8, 建議 × 4, 目前 × 1.5)；標「建議」「目前」；**點圖上任一處直接設定卡數**。
     - 「人數 → 每人速度」：目前卡數與切法下，橫軸 1 到 max(上限, 目前人數)（core 的 `speedCurve` 範圍，見 5.1）；標「目前」與「上限」；超過上限的區段以 `why` 標出（虛線）。
     - 兩張圖都有 Y 軸刻度、格線與「每人速度（字/秒）」等含單位的軸標題。
   - 最後一列（同一行）：左邊「更多圖表（Roofline，專家用）」`Collapse`（展開後全寬，對數雙軸含單位），右邊「驗證指令」文字按鈕 → Drawer。
6. **方案比較**（v9 已取代，見 `2026-10-22-compare-v9-design.md`）：第一次「加入比較」後在列表下方淡入（`Card` + `Table`：平台、數量、模型／精度、同時人數、每人速度、首字、上限人數、功耗），最多 3 個，逐一移除或清除。
7. **頁尾**：資料版本、準確度（Drawer）、「費用：尚未包含」「尾端延遲（P95）：尚未估算」（hover 看說明）。
8. **Drawer**：驗證指令（兩個 code block：「1. 啟動服務」「2. 壓測」，等寬、每個參數一行加 `\`、右上角複製；下方說明結果中哪個值對應每人速度與首字）、準確度、人數漏斗、自訂工作、自訂速度、HF 匯入、手動輸入模型、新增／編輯硬體。**Modal**：依據、引用。

## 5. core 新增（網站不得自己實作公式）

### 5.1 `estimatePerformance`：指定平台、卡數、人數

輸入：`RequirementInput` 的欄位（含 `users`）＋ `platform: string | CustomPlatformInput` ＋ `gpus`（1～1e5；Mac 為台數）＋ `tp?`（使用者在切法選單選的 TP）。

- `splits`：每個合法 t（`legalTpOptions`，且 t ≤ gpus），shape = { tp: t, replicas: floor(gpus ÷ t) }，各附：`ok`、`why`、每人速度、首字（`checkShape` 在 `users` 人）、`maxConcurrent`。
- 預設切法（`recommendedTp`）：和建議值同一套排序（Ruling R34／`maxConcurrentForGpus`）：人數上限最大，同上限取 t 較小。人數上限全是 0 時：取 `checkShape` 走得最遠的（weights → mem → ttft → 速度，同 `singleUserWhy` 的順序），再取每人速度最快、t 較小。
- **一致性（必須）**：`gpus` 等於 `estimateRequirements` 該平台的 `expected.gpus` 且未給 `tp` 時，切法、每人速度、首字、`maxConcurrent`、`usage` 與 `estimateRequirements` 完全相同。
- `tp` 給了但不合法或大於 `gpus` → `CoreInputError('invalid-input')`。
- 回傳：`ok`、`why`、`detail`、`shape`、`recommendedTp`、`splits`、`usage`（`shapeUsage` at users；權重或 1 人都放不下時 null）、`maxConcurrent`、`speedCurve`（`shapeProfile` 在 [1, max(maxConcurrent, users)] 取 24 點；每點附 `why`，讓圖畫出不可行區段）、`queueing`、`powerKw`／`powerNote`（同 `estimateRequirements` 的規則）、`verifyCommand`／`verifyNote`、`basis`、`hasEstimate`、`hasUser`、`warnings`、`dataVersion`。只用預期 η。
- 規模、上下文、TP 問題回傳 `ok: false` + `why`，不丟錯。

### 5.2 `estimatePerformanceSweep`：卡數範圍的速度曲線

輸入：同 5.1，`gpus` 改為 `gpusList: number[]`（1～64 個，各 1～1e5，遞增不重複）。回傳每個卡數的 `{ gpus, ok, why, shape, tokPerSecPerUser, ttftSec, maxConcurrent }`（切法照 5.1 的預設排序；權重放不下時速度與首字為 null）以及一份共用的 `basis`／`hasEstimate`／`hasUser`／`warnings`。每個點另附 `fastest: { shape, tokPerSecPerUser, ttftSec } | null`：在這個卡數下、能服務目前人數且達標的切法中每人最快的一種（取自同一份切法評估，沒有新公式；沒有任何切法達標時為 null）。預設切法的點在切法改變時可能不單調（例如多一張卡讓另一種切法服務更多人），這是真實的；但「卡數 → 每人速度」圖畫的是每個卡數的 `fastest`（Ruling W9：多出的卡只會讓同一 t 的份數變多，所以最快的達標切法對卡數不會下降，看得出曲線何時變平），沒有達標切法的卡數退回預設切法的數字、畫成虛線。點一下設定 `{ gpus, tp: 該點的切法 }`（與預設切法相同時不帶 tp）；網站在點的 hover 說明寫出該點的切法。

### 5.3 自訂硬體 `CustomPlatformInput`

```
{ name, unit: 'gpu' | 'machine', gpusPerNode (gpu: 1～8；machine: 1),
  memGB, memBwTBs, tflops（使用者填的每張卡 dense 算力，對任何 computeDtype 都用這個值）,
  tdpW?（選填）, nvlinkBidirGBs?（選填）, engine: 'vllm' | 'mlx' }
```

- 使用者填的值在 basis 裡是 `user`。
- 效率係數（etaBw、etaBwLow、etaCompute、memUtil、allreduce 延遲、t_fixed、TTFT overhead）、vLLM 預設值與 KV block 大小，借用設定檔指定的同引擎「範本平台」（`config/custom-hardware.yaml`，見 6.2），basis 裡一律標 `estimate`，rationale「這台硬體沒有實測，借用 <範本平台> 的校正值」。
- tpOptions：有 `nvlinkBidirGBs` 時為 {1,2,4,8} 中 ≤ gpusPerNode 者，否則只有 [1]（沒有互連頻寬就無法估 all-reduce）。
- `estimateRequirements` 新增選填 `customPlatforms: CustomPlatformInput[]`（最多 8 個）；結果的 `perPlatform` 在 bundle 平台之後依序加上，`platform` 為 `custom:0`、`custom:1`…；`best` 只看 `group: nchc`，不受影響。

### 5.4 匯入的模型 `{ imported: { model, source } }`

- `model` 輸入多一種：`{ imported: { model: Model（ModelSchema，含出處）, source: Source } }`，由網站的 HF 匯入產生（6.3）。core 用和 `data:build` 相同的模型檢查（`layerShapeIssues`、`moeParamsIssue`、`mlaLayoutIssues`、`ModelSchema`），不合法 → `CoreInputError('invalid-input')`。
- `source.id` 必須等於模型各欄位的 `source`；basis 照常用 `fromSourced`。
- 不做來源國檢查，結果帶 `CUSTOM_MODEL_WARNING`（主設計 §2.2：使用者輸入的模型不檢查，但一律警告）。`quantOptions` 的規則同目錄模型（新增 `quantOptionsFor(bundle, model: Model)`）。

### 5.5 `peakConcurrentFromTotal`：人數漏斗（主設計 §4.3）

- 輸入：`total`（1～1e9）、`dailyActiveShare?`、`requestsPerActivePerDay?`、`peakHourShare?`（未給 → 設定檔預設）、`workload`、`speed`。
- 只適用 `kind: chat` 的工作：λ = total × d × r × p ÷ 3600；同時進行數 C = λ × 服務時間，服務時間取速度目標的上限 = maxTtftSec + outputTokens ÷ minTokPerSec（**設計者判斷**：實際服務時間取決於結果，用目標上限避免循環，結果偏保守，並在 basis 寫明）；回傳 `users = max(1, ceil(C))` 與 basis。
- `kind: agent` 的工作 → `CoreInputError('invalid-input')`，訊息「研究助理類任務請直接填尖峰同時在線人數」；網站在漏斗 Drawer 顯示這句，不顯示換算。

## 6. 資料新增

### 6.1 漏斗預設值

`config/workloads.yaml` 新增 `funnel`：`dailyActiveShare`（0.05，`measured`，GWDG）、`requestsPerActivePerDay`（7，`estimate`，由 GWDG 數字推算，Ruling R5）、`peakHourShare`（0.2，`estimate`，取 15–20% 區間的上限以偏保守，evidence 為 `docs/research/user-questions.md` §3 的來源）。來源補進 `config/sources.yaml`。

### 6.2 自訂硬體範本

`config/custom-hardware.yaml`：`templates: { vllm: { platform: <id>, rationale, evidence }, mlx: { platform: <id>, … } }`。validator 檢查平台存在、其校正設定的 `engine` 等於鍵。預設 `vllm` → `nano4-h200`、`mlx` → `mac-studio-m5u-512`。借用的是平台的校正設定與 vLLM 預設值：H200 在 nano4（220 node）與 nano5（16 node）都有，兩個平台共用 `nvidia-default` 校正設定、vLLM 預設值也相同，選 nano4 只因為它是主要的 H200 機房，數值與選 nano5 相同。rationale 寫「`nvidia-default` 的擬合點來自 H200 SXM 實測（`config/calibration.yaml` 以 nano5-h200 標記，硬體與 nano4-h200 相同）」，evidence 列出那些校正點的來源 id。

### 6.3 瀏覽器內 HF 匯入

把 `packages/data/src/hf-import.ts` 的抓取流程（API → config.json → hf_quant_config.json → safetensors index）抽成不依賴 Node 的 `hf-fetch.ts`：`fetchHfModel(repo, { fetch, token?, revision?, origin? })` → `{ ok: true, model, source, notes } | { ok: false, status: 'denied' | 'not-found' | 'invalid' | 'unparsable' | 'network' | 'gguf', message, missing?, unsupported?, repo?, sha?, baseModels? }`（issue #17：`unsupported` 為尚未建模的結構，每種一項；`gguf` 附 model card 的 `base_model`）。CLI 與網站共用；網站經 `@nchc/data/hf` 子路徑匯入。token 只留在記憶體，不寫入網址或儲存。

### 6.4 準確度摘要

`AccuracyReport` 新增 `byPlatform: { platform, metric, role, n, meanAbsErrorPct, maxAbsErrorPct }[]`（`calibrate.ts` 產生）。網站匯入 `packages/data/dist/accuracy.json`（`src/accuracy.ts` 是唯一匯入點）；`web:dev`／`web:build` 先跑 `pnpm calibrate`。沒有比對點的平台顯示「無實測」。

## 7. 網站狀態與網址

- 刪除 `mode`、`haveCount`、`havePlatform`。
- 新增：`overrides: Record<rowKey, { gpus: number; tp?: number }>`、`customPlatforms: CustomPlatformInput[]`、`customModel: null | { kind: 'manual'; value: ModelOverride } | { kind: 'hf'; repo; sha; imported?: { model; source } }`、`workload: string | { base; inputTokens; outputTokens; cacheHitRate }`、`speed: string | { minTokPerSec; maxTtftSec }`、`pins: Pin[]`（最多 3）、`dialog: DialogId | null`、`basisFilter`。
- 改變 `users`／`workload`／`model`／`quant`／`speed` 清除 `overrides`。
- 網址：`n w m q s lang` 沿用；`o=nano4-h200:8:2,custom:0:4`（rowKey:gpus[:tp]）；`x=` 為 base64url JSON `{ hw?, wl?, sp?, mm? }`（自訂硬體、工作、速度、手動模型），解碼後逐項用 core 的 schema 驗證，不合法的丟掉；HF 模型存 `hf=owner/name@sha`，載入時重新抓取（失敗顯示錯誤並退回預設模型）。比較表與展開狀態不進網址（**設計者判斷**：它們是一次瀏覽的工作狀態）。

## 8. 非目標

- 成本（缺國網費率）、P95 尾端延遲：只做誠實標示。
- 跨 node 切分、多節點 TP。
- 設定檔與 core 文字的英文版（沿用第二階段限制：英文介面中，來自設定檔與 core 的文字仍是中文）。
- 模型能力等級（設定檔沒有資料；「更大的模型」以參數量排序）。

## 9. 驗證

- core：5.1 一致性（每個目錄平台 × 預設輸入與另兩組輸入）、加卡在同一切法下每人速度不降、少於建議時 `ok: false` 與 why、`tp` 不合法丟錯、Mac 與 GPU 各一例、`scale`；5.2 點數與 5.1 一致；5.3 basis 狀態（user／estimate）、無 NVLink 只有 TP 1；5.4 目錄模型轉成 imported 後結果與目錄 id 相同（除了警告）；5.5 數值與 agent 拒絕。
- 網站：元件測試涵蓋每個入口、建議按鈕、清除規則、網址往返、建議動作套用；jsdom 不算動畫驗證。
- Playwright：桌面淺色／深色、手機 390；展開的試算區；預算不足的列；卡數多於建議的列；新增硬體；模型找不到；人數聚焦提示；比較表；每個 Drawer 與 Modal；390／768／1024／1440 × 60 node／20 台的 `scrollWidth`；逐格截圖（人數 15→200、套用建議動作、展開一列、最佳方案換列、圖示跨過放不下門檻）；console 無錯誤；`reducedMotion: 'reduce'` 時直接到最終狀態。

## 10. 使用者決定紀錄（2026-10-21，demo 回饋）

- 試算區不用 Tabs；只有很少用的專家圖可以收起來。
- 體驗與原因同一列；兩張曲線另一列。
- 「更多圖表」與「驗證指令」放最下方、同一行（左右）。
- 圖表要有 Y 值與含單位的軸標題。
- 「每副本」改白話。
- 驗證指令用 code block。
- 依據改 Modal，與引用一致。
- GPU 平台每 node 一個圖示（與 v7 每張 GPU 一個方塊的已核可差異）。

## 11. 實作時的決定（2026-10-21）

網站（ledger `.superpowers/sdd/2026-10-21-web-v8/progress.md`）：

- W1：HF 模型從網址載入、尚未重新抓取時，答案顯示載入中（`MainView` 的 `loading`），失敗時提示並退回預設模型。
- W2：~~HF 匯入 Drawer 先請使用者確認發表者與 ISO2 國別（core R6）~~（2026-10-22 由 W12 取代），`invalid` 有自己的訊息。
- W3：新增硬體的算力欄位依引擎標示：vLLM 為每張卡 dense 峰值，MLX 為實測可達（effective）（core R3）。
- W4：句子元件測試在整套測試的負載下也要穩定（等待結果狀態，不依賴預設 5 秒）。
- W5：網站匯入 `accuracy.json` 後，`typecheck`、`web:dev`、`web:build` 先跑 `data:build` 與 `calibrate`，並從乾淨狀態驗證 typecheck。
- W6：列上的卡數輸入只在 Enter、失焦與 −/+ 時送出；不合法的值不改狀態，失焦後顯示上次的值。
- W7：「人數降到 M」保留該列的卡數（在我的卡上服務較少的人）。
- W8：權重或 1 人都放不下的切法在切法選單中停用並標「放不下」，不會讓使用者卡在只有原因的畫面。
- W9：「卡數 → 每人速度」畫每個卡數下能服務目前人數的最快切法（`SweepPoint.fastest`，見 5.2），曲線不下降。
- W10：core 顯示給使用者的文字不用「副本」，改「每份模型 N 張卡」。
- W11：CI 在 `pnpm test` 之後加跑 `pnpm web:build`（抓 Vite 建置失敗）；`web:e2e` 需要瀏覽器、較重，只在本機跑。
- W12（2026-10-22，取代 W2 的發表者確認與 core R6）：自訂模型（HF 匯入、手動輸入）不詢問發表者與國別，也不做來源國檢查（主設計 §2.2）。兩個自訂模型 Drawer 在任何輸入之前，以醒目的警告（antd `Alert` warning，粗體標題「國網中心模型使用規定」）顯示 `CUSTOM_MODEL_WARNING` 的規定全文；結果照常帶同一段警告。匯入的模型記錄 `UNCHECKED_ORIGIN`（`{ developer: '使用者自訂', country: 'ZZ' }`，與手動輸入的模型相同；ZZ 為 ISO 3166 使用者自訂代碼）。網址不再存發表者（舊連結的 `x.hfo` 忽略）；從網址載入的 HF 模型一律直接重新抓取，gated repo 則開啟 Drawer 並直接顯示 token 欄位。目錄模型（建議清單、預設）照常由 `data:build` 依 `policy.yaml` 檢查，CLI 的 `data:import` 仍必須帶 `--developer`／`--country`。
- W13（2026-10-22，issue #17，取代同日先前「失敗時列出未建模結構」的版本）：匯入的模型一律得到數值（CLAUDE.md「Goal for imported models」：實測 > 精確計算 > 推估 >>> 錯誤）。計算機還沒精確建模的結構以保守方式推估，結果帶 core 的 `nonstandard-config` 警告；答案下方的推估通知（`EstimateNotice`）用使用者的語言一句話列出推估的結構，每項推估的假設收在 `Collapse` 內，並提供「請求精確支援這個架構」（開啟預填 repo、commit 與推估部分的 GitHub issue form `.github/ISSUE_TEMPLATE/unsupported-model.yml`，標題 `Support model: …`；連結不含 token，原因上限 1,500 字）。匯入成功時若有推估，提示改為 warning。匯入失敗只會是計算機的錯誤：錯誤畫面列出缺少的欄位一次，並提供「回報這個錯誤」（同一個 issue form，標題 `Import error: …`）。GGUF repo 自動以 model card 的 `base_model` 讀取架構（推估），不再需要使用者改匯入。
- W14（2026-10-22）：句子裡的模型選單寬度以整句為上限（長的 HF repo 名稱以省略號截斷），手機上模型這一段可以在選單前換行；先前長名稱會讓 390 px 出現水平捲動。
- W15（2026-10-22）：模型搜尋輸入 `owner/name` 後按「匯入 owner/name」直接匯入（不再開 Drawer 讓使用者確認同一個字串）；答案區顯示匯入進度。HF Drawer 只在兩種情況出現：需要授權的 repo（直接顯示 token 欄位），或搜尋字串不是 `owner/name` 時按「從 Hugging Face 匯入」。國網規定的警告已隨每個自訂模型的結果顯示。模型選單底部常駐提示「找不到你的模型？在上方輸入 Hugging Face 的 owner/name 即可匯入，或手動輸入架構」，讓使用者知道搜尋也接受 HF repo。
- W16（2026-10-22）：「我的模型」：使用者匯入（成功讀取）或手動輸入的模型自動存在這個瀏覽器（localStorage，最多 20 個，最新的在前；匯入的只存 repo@commit 與名稱，不存 token 也不存計算結果；儲存不可用時清單為空，不影響其他功能）。模型選單最前面列出它們（說明「我匯入的模型 · repo@commit」或「我手動輸入的模型」），選用時匯入的模型在同一個 commit 重新讀取（之後若架構已精確建模，就得到精確數值）。選單底部「管理我的模型（N）」開啟 Drawer，可逐一使用、刪除或全部清除（有確認）。
- W17（2026-10-22）：匯入時答案區（以及 token Drawer 內）以 antd `Timeline` 逐步顯示正在做什麼（讀取模型資訊、config.json、量化設定、權重檔大小、原始模型、解析架構），不只是轉圈。匯入失敗以 notification 顯示並保留到使用者關閉（先前的 toast 會因 effect cleanup 立刻消失）；計算機錯誤附「回報這個錯誤」。不是語言模型的 repo（Hugging Face task 不是生成文字，例如 image-feature-extraction）回報 `not-language-model`，說明計算機估算的是 LLM 推論，而不是列出缺少的欄位。

core（ledger `.superpowers/sdd/2026-10-21-core-v8/progress.md`）：

- R1：`estimatePerformance` 的規模測試：gpus 100001 丟 `invalid-input`；gpus 1e5 配 1e7 人不丟錯，回傳 `ok: false` 與 why ∈ {mem, bw, compute, ttft}，除非該切法真的能服務 1e7 人（此時 `ok: true`）。
- R2：自訂平台沒有 NVLink，或借用的 all-reduce 延遲為 0（MLX 範本）時只有 TP 1，避免 TP>1 的通訊被當成免費。
- R3：MLX 範本 `etaCompute = 1.0`，因為目錄裡 Mac 的 TFLOPS 是實測可達值。
- R4：自訂平台的 basis 路徑以列為鍵：`estimateRequirements`／`explain` 用 `custom:<i>.<field>`，單一平台的 `estimatePerformance`／Sweep 用 `custom.<field>`。
- R5：漏斗的 `requestsPerActivePerDay`（7）標 `estimate`（工作日數是假設，來源沒寫），不是 `derived`。
- R6：~~`fetchHfModel` 必須帶 `origin`（發表者與國別），由使用者確認，不自動猜測。~~ 2026-10-22 起 `origin` 選填（W12）：CLI 一律帶入；網站不帶，模型記錄 `UNCHECKED_ORIGIN`。
- R7：選定切法的功耗只算該切法用到的 GPU（tp × 份數），閒置的卡在 `powerNote` 註明。
- R8（2026-10-22，issue #17）：Model 新增推估與新架構所需的欄位，全部由 core 計算：`moe.layers`（MoE 層數，dense 層不算專家；由 config 的層型欄位精確數出）、`moe.matrices`（2 = 非 gated 專家）、`moe.width`（latent MoE 的寬度）；layer group `state`（固定大小的 per-sequence 狀態，linear attention／short conv）與 `none`（沒有 per-sequence cache 的 MLP／MoE block）；MLA 可與 `state`／mamba 群組並存（MLA 與 linear attention 混合）；`extraCache`（每 token 的額外 cache，每個 TP rank 各一份，加上固定狀態：indexer key cache、記憶層、重複執行的層）；`estimates`（推估的部分，觸發 `nonstandard-config` 警告與 `estimate` basis）。量化新增 `native-other`：計算機還沒建模的原生格式，權重記憶體用 checkpoint 檔案大小，其餘數值保守（每參數 0.5 bytes 拆專家權重、BF16 算力、16-bit KV）；若以此拆分會讓專家權重超過 checkpoint，改依參數比例拆分（basis 列出）。
