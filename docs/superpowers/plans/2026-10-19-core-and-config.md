# 計算核心與集中設定 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立一個純 TypeScript 的推論算力計算核心，以及經 schema 與出處規則驗證的集中設定。兩者合起來輸出一份 JSON bundle，供之後的網站與 MCP 共用。

**Architecture:** 採用 pnpm monorepo，分成三個套件：

- `packages/schema`：zod schema 與型別定義。
- `packages/data`：讀取 `config/*.yaml`，驗證 schema、引用與出處，最後輸出 `dist/bundle.json`。另外附一支 HF 匯入 CLI 與校正報告工具。
- `packages/core`：只有純函數，負責記憶體、時間、求解與計算依據。不依賴 DOM，也不依賴 Node API。

網站與 MCP 不在本計畫範圍，會各自另寫計畫。

**Tech Stack:** Node.js（本機現有 v24）、pnpm（透過 corepack）、TypeScript、zod、yaml、Vitest、tsx。

**Spec:** `docs/superpowers/specs/2026-10-19-inference-calculator-design.md`（下文以「spec §x」引用）。研究數據在 `docs/research/`。

## Global Constraints

- **資料誠信（spec §2.1）**：每個進入計算的數值都必須帶 `status ∈ {official, measured, derived, estimate, unverified}`，不得有任何沒有出處的數值。規則如下：
  - `official` / `measured` / `unverified` 必須附 `source`。
  - `derived` 必須附 `formula` 與 `inputs`，或附 `source`。
  - `estimate` 必須附 `basis`（判斷依據文字），以及至少 1 個 `evidence` 出處 id。
  - 使用者覆寫的值，在 core 中標為 `user`。
- **計算結果的可信度取最弱的輸入**：只要用到任何 `estimate`、`unverified` 或 `user` 的值，結果就要帶出 `hasEstimate` / `hasUser`，並附上用到的清單。
- **配置單位是「張 GPU」**（spec §10.2）：
  - 每個副本使用 `t ∈ {1,2,4,8}` 張 GPU，且 `t ≤ 每 node 卡數`。
  - 副本數不限。
  - 在所有合法配置中，選 GPU 總數最少的那一個。
  - Mac 以「台」為單位，`t = 1`。
  - 跨 node 或跨台切分不在本計畫範圍，遇到時回報不可行，原因寫「跨 node 切分尚未支援」。
- **「同時最多 N 人」的解讀**（spec §8.3.3）：
  - 對話類：同時在生成的人數 = N，佔用記憶體的人數 = N。
  - Agent 類：佔用記憶體的工作階段 = N，同時在生成的人數 = `max(1, ceil(N × 0.033))`。
- **套件版本不可憑印象寫**：執行 Task 1 時，查 `https://registry.npmjs.org/<pkg>`，選擇發布至少兩週的最新穩定版，並在 `package.json` 釘死確切版本。
- **模型限制**：見 spec §2.2。
- **公式要能追溯到理論依據**：`packages/core` 中每個公式函數的 JSDoc，都要寫出它對應的講義編號，例如 `[R-LEC B1]`，編號見 `docs/research/lecture-formulas.md`。講義沒有涵蓋的公式，要寫出 spec 章節與出處。
  - 對應關係（2026-10-20 依改寫後的講義文件更新，審查 L5）：`decodeStep` 對應 B1、B3、A4、C1、B8（通訊 F3、G1，t_fixed G2）；`ttftSec` 對應 A2、A5、B1、B7、B8、B9（通訊 F2、F3）；`weightsReadBytes` 對應 B3、B9（跨步不重用 B6；B5 只是零重用的對照，不引用）；η_bw 沒有講義對應項（A4、B1），不標 lecRef；power 對應 D1；dense 峰值對應 C2。
  - `BasisItem` 要附 `lecRef?: string`。
- **YAML 是唯一的資料來源**：網站與 MCP 只讀 `packages/data/dist/bundle.json`，程式碼中不得寫死任何硬體、模型或負載數值。測試用的 fixture 例外。
- **CI 規則**：
  - schema 錯誤、引用錯誤、出處缺漏：讓 CI 失敗。
  - 校正驗證點的誤差：只發出警告，並寫進報告（spec §10.1）。

## Review Focus

1. **模型在最大 TP 下仍然放不下**（例如 Llama 3.1 405B BF16 跑在 H100 上）：應該回傳 `{ok:false, reason:'weights'}` 並附原因文字。不可以無限迴圈，也不可以出現 NaN。測試放在 Task 8。
2. **輸入值超出合理範圍**，例如 N=0、負數、小數、N=10⁷、`outputTokens=0`、`cacheHitRate=1`：
   - 在 core 入口以 zod 驗證，拒絕並回傳明確錯誤。
   - N 必須是正整數，最大 10⁷。
   - `outputTokens ≥ 1`。
   - `0 ≤ cacheHitRate < 1`。
   - 測試放在 Task 9。
3. **TP 不能整除注意力頭數的模型**：例如 `microsoft/phi-4` 有 heads=40、kvHeads=10，依 vLLM 規則只有 TP 1、2 合法：該 TP 必須被排除，不能被選中。KV 頭少於 TP 時（例如 kvHeads=4、TP=8），依 vLLM 的規則允許複製 KV 頭。測試放在 Task 8。
4. **GB200 的 TDP 是 `null`（未查證）**：功耗結果應該是 `null` 並標示原因，不可以是 NaN 或 0；其他結果照常計算。測試放在 Task 9。
5. **HF 的 config 缺欄位，或採巢狀 `text_config`（多模態模型）**：匯入工具要列出缺少的欄位並結束，退出碼為 2，不寫入任何猜測值。巢狀的 `text_config` 要能正確解析。測試放在 Task 5。

---

## 檔案結構

```
package.json                    pnpm workspace 根；scripts: test, typecheck, data:build, data:import, calibrate
pnpm-workspace.yaml
tsconfig.base.json
vitest.config.ts                測試範圍：packages/*/test/**/*.test.ts
.github/workflows/ci.yml
config/
  meta.yaml                     dataVersion
  sources.yaml                  出處清單
  hardware.yaml                 GPU / 晶片規格
  platforms.yaml                國網平台與 Mac 部署形態
  quantization.yaml
  models/*.yaml                 每個模型一檔（由 HF 匯入 CLI 產生，人工補出處）
  workloads.yaml                工作負載、速度預設、同時人數解讀
  calibration.yaml              η、記憶體利用率、all-reduce 參數、校正資料點
packages/schema/src/
  provenance.ts                 Status、Sourced<T>、Source
  domain.ts                     Hardware、Platform、Quantization、Model、Workload、SpeedPreset、Calibration、Meta
  bundle.ts                     Bundle 型別（建置輸出）
  index.ts
packages/schema/test/provenance.test.ts, domain.test.ts
packages/data/src/
  load.ts                       讀取 config/ → RawConfig
  validate.ts                   schema 驗證、引用完整性、出處規則 → ValidationIssue[]
  build.ts                      CLI：驗證並輸出 dist/bundle.json
  hf-import.ts                  CLI：從 HF 匯入模型並產生 YAML
  hf-parse.ts                   純函數：解析 config.json 與 safetensors
  calibrate.ts                  CLI：產生 dist/accuracy.json，並對偏差發出警告
packages/data/test/…            fixtures 與測試
packages/core/src/
  model-math.ts                 參數、專家、權重、KV
  timing.ts                     decode 單步時間、prefill 佔用、TTFT、all-reduce
  concurrency.ts                同時人數解讀
  solve.ts                      合法 TP、單一配置檢查、最少 GPU 求解、容量上限
  api.ts                        estimateRequirements、estimateCapacity、findFeasibleModels、explain、verifyCommand
  basis.ts                      計算依據收集
  index.ts
packages/core/test/…
```

---

### Task 1: Monorepo 骨架與出處 schema

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `packages/schema/package.json`, `packages/schema/tsconfig.json`, `packages/schema/src/provenance.ts`, `packages/schema/src/index.ts`
- Test: `packages/schema/test/provenance.test.ts`

**Interfaces:**
- Produces:
  - `Status = 'official'|'measured'|'derived'|'estimate'|'unverified'`
  - `CoreStatus = Status | 'user'`
  - `sourced<T extends z.ZodTypeAny>(inner: T)`：zod 工廠函數，產出 `{ value, unit?, status, source?, evidence?, basis?, formula?, inputs?, verified }`，並以 `superRefine` 強制 Global Constraints 中的出處規則。`verified` 為 `YYYY-MM-DD` 格式。
  - `Sourced<T>`
  - `SourceSchema = { id, title, url, accessed: date, kind: 'official'|'paper'|'benchmark'|'secondary'|'internal' }`

- [ ] **Step 1: 啟用 pnpm，並查詢 typescript、zod、yaml、vitest、tsx、@types/node 的版本**

```bash
corepack enable && corepack prepare pnpm@latest --activate && pnpm -v
for p in typescript zod yaml vitest tsx @types/node; do curl -s https://registry.npmjs.org/$p | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s),c=Date.now()-14*864e5;const v=Object.keys(j.versions).filter(k=>!/-/.test(k)&&new Date(j.time[k])<c).sort((a,b)=>new Date(j.time[a])-new Date(j.time[b])).pop();console.log('$p',v)})"; done
```
預期結果：每個套件印出一個版本號，用這些版本寫進 `package.json`。

- [ ] **Step 2: 寫失敗的測試 `packages/schema/test/provenance.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { sourced } from '../src/provenance';
const S = sourced(z.number());
describe('sourced()', () => {
  it('official 需要 source', () => {
    expect(S.safeParse({ value: 141, unit: 'GB', status: 'official', verified: '2026-10-19' }).success).toBe(false);
    expect(S.safeParse({ value: 141, unit: 'GB', status: 'official', source: 'nvidia-h200', verified: '2026-10-19' }).success).toBe(true);
  });
  it('estimate 需要 basis 與至少一個 evidence', () => {
    expect(S.safeParse({ value: 0.7, status: 'estimate', basis: 'x', verified: '2026-10-19' }).success).toBe(false);
    expect(S.safeParse({ value: 0.7, status: 'estimate', basis: 'x', evidence: ['apple-mlx'], verified: '2026-10-19' }).success).toBe(true);
  });
  it('derived 需要 formula+inputs 或 source', () => {
    expect(S.safeParse({ value: 4, status: 'derived', verified: '2026-10-19' }).success).toBe(false);
    expect(S.safeParse({ value: 4, status: 'derived', formula: '72/18', inputs: ['nchc-nano4-manual'], verified: '2026-10-19' }).success).toBe(true);
  });
  it('verified 必須是日期', () => {
    expect(S.safeParse({ value: 1, status: 'official', source: 'a', verified: 'yesterday' }).success).toBe(false);
  });
  it('不接受 user 狀態（user 只存在於 core 執行期）', () => {
    expect(S.safeParse({ value: 1, status: 'user', verified: '2026-10-19' }).success).toBe(false);
  });
});
```

- [ ] **Step 3: 執行測試，確認失敗**

Run: `pnpm vitest run packages/schema/test/provenance.test.ts`
Expected: FAIL（找不到模組 `../src/provenance`）

- [ ] **Step 4: 建立 workspace 設定檔，並實作 `provenance.ts`**

設定 TS 為 `strict`，`module` 與 `moduleResolution` 用 `bundler`。根目錄 `package.json` 的 scripts：

- `test`: `vitest run`
- `typecheck`: `tsc -b packages/*`
- `data:build`、`data:import`、`calibrate`（Task 4、5、10 補上實際指令）

- [ ] **Step 5: 執行測試，確認通過**

Run: `pnpm vitest run packages/schema/test/provenance.test.ts` → Expected: 5 passed

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json vitest.config.ts packages/schema
git commit -m "feat(schema): monorepo scaffold and provenance schema"
```

---

### Task 2: 領域 schema

**Files:**
- Create: `packages/schema/src/domain.ts`, `packages/schema/src/bundle.ts`
- Modify: `packages/schema/src/index.ts`（匯出新增的型別）
- Test: `packages/schema/test/domain.test.ts`

**Interfaces:**
- Consumes: `sourced`, `Status`（Task 1）
- Produces（皆為 zod schema 加上推導型別；`S<T>` 代表 `sourced(T)`）：
  - `Hardware`
    - 欄位：`{ id, name, memGB:S<number>, memBwTBs:S<number>, tflops:{ fp8?:S<number>, bf16?:S<number>, effective?:S<number> }, tdpW:S<number|null>, nvlinkBidirGBs?:S<number> }`
    - `tflops` 一律存 dense 值；Mac 只填 `effective`。
  - `Platform`
    - 欄位：`{ id, name, sub, group:'nchc'|'self', unit:'gpu'|'machine', hardware:<hardware id>, gpusPerNode:S<number>, nodes?:S<number>, tpOptions:number[], calibration:<calibration profile id>, scheduling?:string }`
  - `Quantization`
    - 欄位：`{ id, name, bytesPerParam:S<number>, computeDtype:'fp8'|'bf16', description:string }`
  - `Model`
    - 欄位：`{ id, name, hfRepo?, origin:{developer:string, country:string /* ISO-3166 alpha-2 */}, baseModel?:string /* 基底模型 repo */, baseOrigin?:{developer,country}, totalParamsB:S<number>, layers, heads, kvHeads, headDim, hidden, attention:'gqa'|'mla', mla?:{kvLoraRank,qkRopeHeadDim}, layerGroups?: Array<{ kind:'full'|'sliding'|'mamba', count:number, kvHeads?:number, headDim?:number, window?:number, kEqualsV?:boolean, ssm?:{ heads:number, headDim:number, stateSize:number } }>, moe?:{experts, topK, expertFfnDim}, maxContext?:number, license?:string, source:<source id>, verified }`
    - `layerGroups` 用來描述混合架構，每一組各自有自己的 KV 頭數、head 維度與 window：
      - gpt-oss：18 層 full + 18 層 sliding（window 128），兩組的 KV 頭數與維度相同
      - Gemma 4 31B：50 層 sliding（KV16、hd256、window 1024）+ 10 層 global（KV4、hd512、k=v）
      - Nemotron 3.5：8 層注意力 + 40 層 Mamba；Mamba 層每個 sequence 的狀態大小固定，與 context 長度無關
    - 沒有 `layerGroups` 時，視為所有層都是 full，使用模型層級的 `kvHeads`、`headDim`。
  - `Policy`
    - 欄位：`{ excludedCountries: string[], decision: S<string> }`
    - 架構整數欄位共用 model 層級的 `source`，不逐欄附出處。
  - `Workload`
    - 欄位：`{ id, name, kind:'chat'|'agent', inputTokens:S<number>, outputTokens:S<number>, cacheHitRate:S<number>, description:string, tierNote:S<string>, demoText:string }`
  - `SpeedPreset`
    - 欄位：`{ id, name, minTokensPerSec:S<number>, maxTtftSec:S<number>, description:string }`
  - `CalibrationProfile`
    - 欄位：`{ id, etaBw:S<number>, etaBwLow:S<number>, etaCompute:S<number>, memUtil:S<number>, allreduceLatencyUs:S<number> }`
  - `ConcurrencyRule`
    - 欄位：`{ agentGeneratingShare:S<number>, chatRule:S<string>, agentRule:S<string> }`
  - `CalibrationPoint`
    - 欄位：`{ id, role:'fit'|'validate', platform, model, quant, workload:{inputTokens,outputTokens,cacheHitRate}, concurrency, metric:'decodeTokPerSec'|'maxConcurrent'|'ttftSec', measured:S<number>, engine:string }`
  - `Meta`
    - 欄位：`{ dataVersion: date }`
  - `Bundle`
    - 欄位：`{ meta, sources: Record<id,Source>, hardware, platforms, quantization, models, workloads, speedPresets, calibration, concurrency, calibrationPoints }`，每一項都是以 id 為 key 的 Record。

- [ ] **Step 1: 寫失敗的測試 `domain.test.ts`**
  - 用一個最小的 H200 `Hardware` 與一個 `Model` 物件驗證 parse 成功。
  - 驗證以下四種情況都會失敗：
    - `Model` 缺少 `kvHeads`
    - `Platform.tpOptions` 含 `3`（只允許 1、2、4、8）
    - `Workload.cacheHitRate.value = 1`（值必須 `<1`）
    - `Workload.outputTokens.value = 0`（值必須 `≥1`）

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pnpm vitest run packages/schema/test/domain.test.ts`
Expected: FAIL

- [ ] **Step 3: 實作 `domain.ts`、`bundle.ts`**
  - `tpOptions` 用 `z.array(z.union([z.literal(1),z.literal(2),z.literal(4),z.literal(8)]))`。
  - 數值的範圍檢查寫在 `sourced(z.number().…)` 的 inner schema 裡。

- [ ] **Step 4: 執行測試，確認通過**

Run: `pnpm vitest run packages/schema` → Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/schema && git commit -m "feat(schema): domain schemas and bundle type"
```

---

### Task 3: 集中設定資料（硬體、平台、量化、負載、校正）

**Files:**
- Create: `config/meta.yaml`, `config/sources.yaml`, `config/hardware.yaml`, `config/platforms.yaml`, `config/quantization.yaml`, `config/workloads.yaml`, `config/calibration.yaml`
- Test: `packages/data/test/config-values.test.ts`（Task 4 完成載入器後才會通過；本 Task 先寫好資料與測試，兩個 Task 合併成一次 commit 也可以）

**Interfaces:**
- Produces：以下 id 供之後的 Task 引用。
  - hardware：`h100-sxm`, `h200-sxm`, `gb200`, `m5-ultra-512`, `gb10-spark`, `m5-pro-64`, `m6-32`
  - platforms：`nano4-h200`, `nano5-h100`, `nano5-h200`, `nano4-gb200`, `mac-studio-m5u-512`, `dgx-spark`, `mac-mini-m5pro-64`, `mac-mini-m6-32`
    - 後三個屬於 `group: self`、`unit: machine`、`tpOptions: [1]`。多台串接不在本計畫範圍。
  - quantization：`bf16`, `fp8`, `int4-awq`
  - workloads：`chat`, `doc`, `assist`
  - speed：`smooth`, `ok`
  - calibration profiles：`nvidia-default`, `mac-mlx`

出處 id 與數值一律取自 `docs/research/`。必填的數值如下：

| 項目 | 值 | status / source |
|---|---|---|
| h100-sxm | memGB 80, memBwTBs 3.35, fp8 1979, bf16 989.5, tdpW 700, nvlinkBidirGBs 900 | official / `nvidia-h100` |
| h200-sxm | memGB 141, memBwTBs 4.8, fp8 1979, bf16 989.5, tdpW 700, nvlinkBidirGBs 900 | official / `nvidia-h200` |
| gb200 | memGB 186, memBwTBs 8, fp8 5000, bf16 2500, nvlinkBidirGBs 1800 | derived，formula「每顆 superchip 數值 ÷ 2 GPU（= 整櫃 ÷ 72）」，inputs `[nvidia-gb200-nvl72]`（review fix，2026-10-20：NVIDIA 只公布每顆 superchip 與整櫃的數字，單 GPU 值是推算，不是 official） |
| gb200 | tdpW `null` | unverified / `nvidia-gb200-nvl72` |
| m5-ultra-512 | memGB 512, memBwTBs 1.2 | official / `apple-mac-studio-specs` |
| m5-ultra-512 | effective 66.6 | derived，formula `pp512 tok/s × 2 × 6.74e9`，inputs `[llamacpp-4167]` |
| m5-ultra-512 | tdpW 300 | measured / `apple-mlx-distributed` |
| nano4-h200 | gpusPerNode 8, nodes 220, tpOptions [1,2,4,8] | official / `nchc-nano4-iservice` |
| nano5-h100 | gpusPerNode 8, nodes 21 | official / `nchc-nano5-page` |
| nano5-h200 | gpusPerNode 8, nodes 16, scheduling `"Slurm partition normal2"` | official / `nchc-nano5-page` |
| nano4-gb200 | gpusPerNode 4, tpOptions [1,2,4] | derived，formula `72 GPU / 18 node per rack`，inputs `[nchc-nano4-manual]` |
| nano4-gb200 | nodes 36 | official / `nchc-nano4-manual` |
| mac-studio-m5u-512 | gpusPerNode 1, unit machine, tpOptions [1] | official / `apple-mac-studio-specs` |
| bf16 / fp8 / int4-awq | bytesPerParam 2 / 1 / 0.53125；computeDtype bf16 / fp8 / bf16 | bf16、fp8：official / `ieee-fp-formats`；int4：estimate，basis「group128 scale 開銷」，evidence `[devtoollab-quant-sizes]` |
| chat | input 1020, output 129, hit 0 | measured / `splitwise-azure` |
| doc | input 12035, output 343, hit 0 | measured / `mooncake-trace` |
| assist | input 126180, output 252, hit 0.957 | measured / `tracelab` |
| smooth | minTokensPerSec 20, maxTtftSec 5 | estimate，evidence `[l1t-office-sizing]` |
| ok | minTokensPerSec 8, maxTtftSec 15 | estimate，evidence `[l1t-office-sizing]` |
| nvidia-default | etaBw 0.70, etaBwLow 0.55, etaCompute 0.50 | estimate，evidence `[martin-alderson-speed, apple-mlx-distributed]`，basis「尚未以國網實測校正」 |
| nvidia-default | memUtil 0.92 | official / `vllm-v032-cache-config`（review fix，2026-10-20：v0.32.0 預設 `gpu_memory_utilization` 0.92，原本的 0.9 是 v0.10.0；驗證指令以 `--gpu-memory-utilization` 釘住同一個值） |
| nvidia-default | allreduceLatencyUs 11.0 | estimate，basis「取 GB200 NCCL ring 4-GPU 小訊息實測；H100/H200 查無實測」，evidence `[arxiv-2607.16100]` |
| nano4-gb200 | allreduceLatencyUs 11.0 | measured / `arxiv-2607.16100`；在 platforms.yaml 的 platform 層覆寫 |
| mac-mlx | etaBw 0.86, etaBwLow 0.81 | derived，formula「Apple MLX 實測 decode × 權重大小 ÷ 標稱頻寬」，inputs `[apple-mlx-distributed]`（review fix，2026-10-20：依原生 FP8 checkpoint 權重檔 133.61 GB 重算，原 0.82 / 0.77 用 127.7 GB；Mac mini 另用 `mac-mini-mlx`，同值但標 estimate） |
| mac-mlx | etaCompute 1.0 | derived，說明「effective 已是實測」 |
| mac-mlx | memUtil 0.75 | estimate，evidence `[mac-llm-calculator]` |
| concurrency | agentGeneratingShare 0.033 | estimate，evidence `[tracelab]`，basis 寫明 3.3% 是生成佔 session 時間的比例、解讀成同時生成比例是推論、人類停頓上限 1 小時時為 14.5%（review fix，2026-10-20；原標 measured） |
| gb10-spark | memGB 128, memBwTBs 0.273, tdpW 140 | official / `nvidia-dgx-spark` |
| gb10-spark | fp8 207.7, bf16 99.8（MAMF 實測，**不用** 1 PFLOP 稀疏 FP4） | measured / `storagereview-dgx-spark` |
| m5-pro-64 | memGB 64, memBwTBs 0.307 | official / `apple-mac-mini-specs` |
| m5-pro-64 | effective 21.8 | derived，formula `pp512 tok/s × 2 × 6.74e9`，inputs `[llamacpp-4167]` |
| m6-32 | memGB 32, memBwTBs 0.170 | official / `apple-mac-mini-specs` |
| m6-32 | effective 13.3 | derived，inputs `[llamacpp-4167]` |
| m5-pro-64 / m6-32 | tdpW `null` | unverified / `apple-mac-mini-specs`（Apple 未公布） |
| dgx-spark | 使用 calibration profile `spark-default` | — |
| mac-mini-* | 使用 calibration profile `mac-mlx` | — |
| spark-default | etaBw 0.68 | derived，formula `23.2 tok/s × 8.03 GB ÷ 273 GB/s`，inputs `[storagereview-dgx-spark]` |
| spark-default | etaBwLow 0.55、etaCompute 0.8 | estimate，basis「MAMF 已是可達矩陣算力，0.8 用來涵蓋非矩陣運算開銷；保守頻寬比照 NVIDIA 預設」，evidence `[storagereview-dgx-spark]` |
| spark-default | memUtil 0.92、allreduceLatencyUs 0 | memUtil official / `vllm-v032-cache-config`（review fix，2026-10-20，同 nvidia-default）；allreduceLatencyUs 為 derived，說明「單機 tp=1，沒有 all-reduce」 |

Spark 與 Mac mini 的出處 url 取自 `docs/research/dgx-spark-mac-mini.md`。

`sources.yaml` 中每個 id 的 url 與標題，照抄 `docs/research/*.md` 對應列的網址。`accessed: 2026-10-19`。

**負載的其他欄位：**

- `tierNote`、`demoText`、`description` 照抄 demo `docs/prototypes/calculator-demo-v7.html` 中 `WL` 物件的文字。
- `tierNote` 一律標為 estimate，evidence 填 `[bixbench, biomnibench, tw-legalbench]`。

- [ ] **Step 1: 寫測試 `config-values.test.ts`**

  依上表逐值斷言，例如：

  ```ts
  expect(b.hardware['h200-sxm'].memBwTBs.value).toBe(4.8);
  expect(b.workloads.assist.cacheHitRate.value).toBe(0.957);
  expect(b.platforms['nano4-gb200'].gpusPerNode.status).toBe('derived');
  ```

  另外斷言「所有 `status:'estimate'` 的值，其 `evidence` 中的 id 都存在於 `sources`」。

- [ ] **Step 2: 撰寫上述 YAML 檔**

- [ ] **Step 3: 在 Task 4 完成後執行測試** `pnpm vitest run packages/data/test/config-values.test.ts` → Expected: PASS

- [ ] **Step 4: Commit**（可與 Task 4 一起）

```bash
git add config && git commit -m "feat(config): sourced hardware, platform, workload and calibration data"
```

---

### Task 4: 資料管線（載入、驗證、輸出 bundle）與 CI

**Files:**
- Create: `packages/data/package.json`, `packages/data/src/load.ts`, `packages/data/src/validate.ts`, `packages/data/src/build.ts`, `.github/workflows/ci.yml`
- Test: `packages/data/test/validate.test.ts`, `packages/data/test/fixtures/{good,dangling-ref,missing-source,estimate-no-evidence,excluded-origin,cn-base-us-publisher}/…`

**Interfaces:**
- Consumes：Task 1 與 Task 2 定義的所有 schema
- Produces：
  - `loadConfig(dir: string): RawConfig`
  - `validateConfig(raw: RawConfig): { bundle?: Bundle; issues: ValidationIssue[] }`
    - `ValidationIssue = { level:'error'|'warning', file:string, path:string, message:string }`
  - CLI `pnpm data:build`：輸出 `packages/data/dist/bundle.json`；只要有任何 error，退出碼為 1。
  - `loadBundle(): Bundle`：讀取 dist 檔，供 core 測試使用。

驗證規則，依序執行：

1. 用 zod 解析每個檔案。
2. 檢查 id 是否重複。
3. 檢查引用完整性：
   - `platform.hardware` 與 `platform.calibration` 必須存在。
   - 所有 `source`、`evidence[]`、`inputs[]` 中的 id 都必須在 `sources` 裡。
   - `calibrationPoint` 引用的 platform、model、quant 都必須存在。
4. 檢查 `models/*.yaml` 的檔名與 `id` 一致。
5. `origin.country` 在 `policy.excludedCountries` 中時，記為 error，message 包含 `policy`。

- [ ] **Step 1: 寫失敗的測試 `validate.test.ts`**
  - `good` fixture 應該得到 0 個 error。
  - `dangling-ref` 應該報 error，path 為 `platforms.x.hardware`。
  - `missing-source` 應該報 error，message 包含 `source`。
  - `estimate-no-evidence` 應該報 error。
  - `excluded-origin`（一個 `origin.country: CN` 的模型）應該報 error，message 包含 `policy`。
  - `cn-base-us-publisher`（美國發表者、`baseOrigin.country: CN`）應該通過。

- [ ] **Step 2: 執行測試，確認失敗**：`pnpm vitest run packages/data/test/validate.test.ts`

- [ ] **Step 3: 實作 `load.ts`、`validate.ts`、`build.ts`**
  - `build.ts` 用 `tsx` 執行。
  - 把根目錄的 `data:build` script 設為 `tsx packages/data/src/build.ts`。

- [ ] **Step 4: 執行測試與建置**

Run: `pnpm vitest run packages/data && pnpm data:build`
Expected:
- 測試全部通過。
- 輸出 `wrote packages/data/dist/bundle.json (dataVersion 2026-10-19)`。
- Task 3 的 `config-values.test.ts` 也通過。

- [ ] **Step 5: 新增 `ci.yml`**

在 push 或 pull request 時執行：

1. `pnpm install --frozen-lockfile`
2. `pnpm typecheck`
3. `pnpm data:build`
4. `pnpm test`
5. `pnpm calibrate`（加上 `continue-on-error: false`，但這支 CLI 本身只會對偏差發出警告）

- [ ] **Step 6: Commit**

```bash
git add packages/data .github config && git commit -m "feat(data): config loader, validation rules, bundle build and CI"
```

---

### Task 5: 模型目錄與 HF 匯入 CLI

**Files:**
- Create: `packages/data/src/hf-parse.ts`, `packages/data/src/hf-import.ts`, `config/models/*.yaml`
- Test: `packages/data/test/hf-parse.test.ts`, `packages/data/test/fixtures/hf/{phi-4,gpt-oss-120b,gemma-4-31b-it,nemotron-3.5-super,mla-synthetic,multimodal-text-config,missing-fields}.json（`mla-synthetic` 是手寫的合成 config，只含 `kv_lora_rank` 等欄位，不取自任何真實模型）`

**Interfaces:**
- Consumes：`Model` schema（Task 2）
- Produces：
  - `parseHfConfig(repo: string, sha: string, config: unknown, safetensorsTotal: number|null): { model?: Model; missing: string[] }`
  - CLI `pnpm data:import <repo> [--token-env HF_TOKEN]`：輸出 `config/models/<slug>.yaml`
    - `source` 設為 `hf:<repo>@<sha7>`，並自動在 `sources.yaml` 中新增對應條目。
    - 有缺漏欄位時退出碼為 2，並印出 `missing: …`。

解析規則：

- 若 config 有 `text_config`，就以它為準。
- `heads` = `num_attention_heads`
- `kvHeads` = `num_key_value_heads ?? heads`
- `headDim` = `head_dim ?? hidden_size / heads`
- `hidden` = `hidden_size`
- `layers` = `num_hidden_layers`
- 有 `kv_lora_rank` 時，`attention: 'mla'`，並設定 `mla:{kvLoraRank, qkRopeHeadDim}`。
- `moe`：
  - `experts` = `num_experts ?? num_local_experts ?? n_routed_experts`
  - `topK` = `num_experts_per_tok`
  - `expertFfnDim` = `moe_intermediate_size ?? intermediate_size`（gpt-oss 沒有 `moe_intermediate_size`，專家維度放在 `intermediate_size`）
  - 有 experts 但缺少 `topK` 時，列入 missing。
- `layerGroups`：依 `layer_types` 或 `hybrid_override_pattern` 這類欄位，統計各類層的數量。若各類層有自己的 KV 頭數或 head 維度（例如 Gemma 4 的 global 層），也要分別記錄。
  - **欄位名稱以 fixture 的實際 config 為準**，對照關係要寫在程式碼註解中。
  - 遇到無法辨識的層類型時，列入 `missing`，不得猜測。
- `origin` 與 `baseModel` 由 CLI 參數 `--developer <名稱> --country <ISO2> [--base <repo> --base-developer <名稱> --base-country <ISO2>]` 提供，**不得自動猜測**。缺少時以退出碼 2 結束。
- **原生量化的 checkpoint**（例如 gpt-oss 以 U8 打包 MXFP4）：`totalParamsB` 取 safetensors 的 `total`。這個值已經 2026-10-19 以架構推算核對：gpt-oss-120b 的專家參數 128×3×2880×2880×36 = 114,661,785,600，與 safetensors 中的 U8 計數一致。
- `slidingWindow` = `sliding_window ?? null`
- `maxContext` = `max_position_embeddings`
- `totalParamsB` = `safetensorsTotal / 1e9`
  - status 為 `official`，source 為 `hf:<repo>@<sha7>`。
  - 缺值時列入 missing。

- [ ] **Step 1: 寫失敗的測試 `hf-parse.test.ts`**，fixture 用實際抓下來的檔案：

```bash
curl -sL https://huggingface.co/microsoft/phi-4/resolve/main/config.json -o packages/data/test/fixtures/hf/phi-4.json
curl -sL https://huggingface.co/openai/gpt-oss-120b/resolve/main/config.json -o packages/data/test/fixtures/hf/gpt-oss-120b.json
```

斷言：

- phi-4：`layers=40`、`heads=40`、`kvHeads=10`、`headDim=128`、`hidden=5120`，沒有 `moe`。
- gpt-oss-120b（safetensors total 傳入 `116829156672`）：
  - `layers=36`、`heads=64`、`kvHeads=8`、`headDim=64`、`hidden=2880`
  - `moe` 為 `{experts:128, topK:4, expertFfnDim:2880}`
  - `layerGroups` 為 `[{kind:'sliding',count:18,kvHeads:8,headDim:64,window:128},{kind:'full',count:18,kvHeads:8,headDim:64}]`
  - `totalParamsB` ≈ 116.83
- gemma-4-31b-it：`layers=60`；`layerGroups` 包含 `{kind:'sliding',count:50,kvHeads:16,headDim:256,window:1024}` 與 `{kind:'full',count:10,kvHeads:4,headDim:512,kEqualsV:true}`。數值出自 `docs/research/open-models.md`，抓下 fixture 後先核對。
- nemotron-3.5-super：`layerGroups` 中 `full` 的 count 為 8（KV2、hd128），另有 `mamba` 組。
- mla-synthetic：`attention='mla'`。
- multimodal-text-config：能從 `text_config` 取出層數。
- missing-fields fixture：`missing` 包含 `'num_hidden_layers'`，且 `model` 為 `undefined`。

- [ ] **Step 2: 執行測試，確認失敗**：`pnpm vitest run packages/data/test/hf-parse.test.ts`

- [ ] **Step 3: 實作 `hf-parse.ts`、`hf-import.ts`**
  - CLI 呼叫 `https://huggingface.co/<repo>/resolve/main/config.json`（要跟隨 redirect）與 `https://huggingface.co/api/models/<repo>?expand[]=safetensors&expand[]=sha`。
  - gated 的回應碼是 401 或 403。遇到時印出 `gated: set HF token via --token-env`，並以退出碼 3 結束。

- [ ] **Step 4: 執行測試，確認通過**

- [ ] **Step 5: 建立初始模型目錄**
  - 對以下 repo 逐一執行 `pnpm data:import`。每一個都已在 2026-10-19 確認 config 可以直接讀取：
    - `openai/gpt-oss-20b`、`openai/gpt-oss-120b`（`--developer OpenAI --country US`）
    - `microsoft/phi-4`（Microsoft, US）
    - `mistralai/Mistral-Small-3.1-24B-Instruct-2503`（Mistral AI, FR）
    - `allenai/OLMo-2-0325-32B`（Ai2, US）
    - `ibm-granite/granite-3.3-8b-instruct`（IBM, US）
    - 依 `docs/research/open-models.md` 第 2 節加入：`google/gemma-4-12B-it`、`google/gemma-4-31B-it`、`google/gemma-4-26B-A4B-it`、`meta-models/Muse-Glimmer-30B`、`ibm-granite/granite-4.2-30b`、`mistralai/Mistral-Medium-3.5-128B`、`mistralai/Mistral-Small-4-119B-2603`、`thinkingmachines/Inkling-Small`、`thinkingmachines/Inkling`、`nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16`、`nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16`、`openai/gpt-oss-120b`（已列）。
    - gated 的 `meta-models/Muse-Spark-Open-816B-A42B`、`taide/Gemma-3-TAIDE-12b-Chat-2602` 需要維護者用自己的 token 匯入。
  - `meta-llama/Llama-3.1-8B`、`Llama-3.3-70B-Instruct`、`Llama-3.1-405B` 是 gated 模型，需要維護者用自己的 HF token 匯入。若沒有 token，這三個模型先不加入，並寫進 `config/models/README.md` 的「待匯入」清單。
  - 任何匯入失敗或有缺漏欄位的 repo，一律不手填猜測值，只記錄在 README。

- [ ] **Step 6: 驗證**：`pnpm data:build` → Expected：0 error，bundle 中模型數量等於成功匯入的數量。

- [ ] **Step 7: Commit**

```bash
git add packages/data config && git commit -m "feat(data): Hugging Face model importer and initial model catalog"
```

---

### Task 6: 模型數學（參數、專家、權重、KV）

**Files:**
- Create: `packages/core/package.json`, `packages/core/src/model-math.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/model-math.test.ts`

**Interfaces:**
- Consumes：`Model` 型別（Task 2）
- Produces：所有單位都是 bytes 或「十億參數」，命名上一律標出單位。
  - `expertParamsTotalB(m: Model): number`：`experts × 3 × hidden × expertFfnDim × layers / 1e9`；dense 模型回傳 0。
  - `activeParamsB(m: Model): number`：`totalParamsB − expertParamsTotalB × (1 − topK/experts)`
  - `expertsTouchedFraction(experts: number, topK: number, batch: number): number`：`1 − (1 − topK/experts)^batch`
  - `weightBytes(m: Model, bytesPerParam: number): number`
  - `weightsReadBytes(m: Model, bytesPerParam: number, batch: number): number`：`((totalB − expertB) + expertB × touched) × 1e9 × bytesPerParam`
  - `kvBytesPerToken(m: Model, kvBytesPerElem = 1): number`
    - GQA：`2 × layers × kvHeads × headDim × kvBytesPerElem`
    - MLA：`layers × (kvLoraRank + qkRopeHeadDim) × kvBytesPerElem`
  - `kvBytesPerSequence(m: Model, contextTokens: number, kvBytesPerElem = 1): number`：
    - 有 `layerGroups` 時，對每一組分別計算再加總：
      - full：`count × kv × ctx`
      - sliding：`count × kv × min(ctx, window)`
      - mamba：`count × ssm.heads × ssm.headDim × ssm.stateSize × 2`（以 BF16 狀態計，與 ctx 無關，**推算值**）
      - 其中 `kv = (kEqualsV ? 1 : 2) × kvHeads × headDim × kvBytesPerElem`
    - MLA 模型改用 `layers × (kvLoraRank + qkRopeHeadDim) × kvBytesPerElem × ctx`。
    - 只有 `slidingWindow`、沒有 `layerGroups` 時，視為全部層都是 sliding。
    - 兩者都沒有時，結果為 `kvBytesPerToken × ctx`。
    - **之後所有 KV 的計算一律呼叫這個函數**，不再自行用「每 token 大小 × context 長度」相乘。

- [ ] **Step 1: 寫失敗的測試**（測試裡直接用物件字面量建構模型，不依賴 bundle）

```ts
const llama70b = { id:'l70', name:'Llama 3.3 70B', totalParamsB:{value:70.55,status:'official',source:'x',verified:'2026-10-19'}, layers:80, heads:64, kvHeads:8, headDim:128, hidden:8192, attention:'gqa', source:'x', verified:'2026-10-19' };
const gptoss120 = { ...llama70b, id:'gpt-oss-120b', totalParamsB:{...llama70b.totalParamsB, value:116.829156672}, layers:36, heads:64, kvHeads:8, headDim:64, hidden:2880, moe:{experts:128, topK:4, expertFfnDim:2880}, layerGroups:[{kind:'sliding',count:18,kvHeads:8,headDim:64,window:128},{kind:'full',count:18,kvHeads:8,headDim:64}] };
const gemma4_31b = { ...llama70b, id:'gemma-4-31b', layers:60, layerGroups:[{kind:'sliding',count:50,kvHeads:16,headDim:256,window:1024},{kind:'full',count:10,kvHeads:4,headDim:512,kEqualsV:true}] };
expect(kvBytesPerToken(llama70b)).toBe(163840);
expect(expertParamsTotalB(gptoss120)).toBeCloseTo(114.6617856, 6);   // = safetensors U8 計數
expect(activeParamsB(gptoss120)).toBeCloseTo(5.7506, 3);
expect(kvBytesPerSequence(gptoss120, 10000)).toBe(1024 * (18 * 10000 + 18 * 128));
expect(kvBytesPerSequence(gemma4_31b, 100000)).toBe(50 * 2 * 16 * 256 * 1024 + 10 * 1 * 4 * 512 * 100000);
expect(expertsTouchedFraction(128, 4, 1)).toBeCloseTo(0.03125, 6);
expect(expertsTouchedFraction(128, 4, 32)).toBeCloseTo(1 - Math.pow(124 / 128, 32), 9);
expect(weightBytes(llama70b, 1)).toBe(70.55e9);
expect(weightsReadBytes(llama70b, 1, 64)).toBe(70.55e9);
expect(kvBytesPerSequence({ ...llama70b, slidingWindow: 4096 }, 126432)).toBe(4096 * 163840);
```

- [ ] **Step 2: 執行測試，確認失敗**：`pnpm vitest run packages/core/test/model-math.test.ts`

- [ ] **Step 3: 實作 `model-math.ts`**

- [ ] **Step 4: 執行測試，確認通過**

- [ ] **Step 5: Commit** `git commit -m "feat(core): model math (active params, MoE experts, weights, KV)"`

---

### Task 7: 時間模型（decode、prefill 佔用、TTFT、all-reduce）

**Files:**
- Create: `packages/core/src/timing.ts`
- Test: `packages/core/test/timing.test.ts`

**Interfaces:**
- Consumes：Task 6 的所有函數
- Produces：
  - `type Replica = { tp: number; memBytes: number; memBwBytesPerSec: number; flopsPerSec: number; etaBw: number; etaCompute: number; memUtil: number; allreduceLatencySec: number; linkBwBytesPerSecPerDir: number }`
    - 硬體數值 × `tp` 換算成單一副本的總量。
    - `linkBwBytesPerSecPerDir` = `nvlinkBidirGBs × 1e9 / 2`；Mac 為 0。
  - `type WorkloadIn = { inputTokens: number; outputTokens: number; cacheHitRate: number }`
  - `allReduceSec(p: number, bytes: number, latencySec: number, bwPerDir: number): number`
    - `p == 1` 時回傳 0。
    - 否則為 `latencySec + 2 × (p−1)/p × bytes / bwPerDir`。
  - `decodeStep(r: Replica, m: Model, bytesPerParam: number, w: WorkloadIn, genBatch: number, opts?: { includeComm?: boolean }): { bwSec: number; computeSec: number; commSec: number; stepSec: number; tokensPerSecPerUser: number }`
  - `ttftSec(r: Replica, m: Model, w: WorkloadIn): number`

`decodeStep` 的公式（spec §5.2、§5.3）。demo 的數字就是用這組公式驗出來的，必須照寫：

```
ctxDecode = in + out/2 ;  newTok = in × (1 − hit) ;  A = activeParamsB(m)×1e9 ;  attn(c) = 4 × layers × heads × headDim × c
bwSec      = (weightsReadBytes(m,bpp,B) + B × kvBytesPerSequence(m, ctxDecode)) / (memBwBytesPerSec × etaBw)
decodeFlop = B × (2A + attn(ctxDecode))
prefillFlop= B × (newTok / out) × (2A + attn(in − newTok/2))        // 穩態下每步要分攤的 prefill
computeSec = (decodeFlop + prefillFlop) / (flopsPerSec × etaCompute)
commSec    = includeComm(預設 true) && tp>1 ? 2 × layers × allReduceSec(tp, B × hidden × 2, allreduceLatencySec, linkBwBytesPerSecPerDir) : 0
stepSec    = max(bwSec, computeSec) + commSec ;  tokensPerSecPerUser = 1 / stepSec
ttftSec    = newTok × (2A + attn(in − newTok/2)) / (flopsPerSec × etaCompute)
```

- [ ] **Step 1: 寫失敗的測試**
  - `allReduceSec(8, 131072, 11e-6, 450e9)` ≈ `11e-6 + 1.75×131072/450e9`（`toBeCloseTo`，精度 12 位）。
  - `allReduceSec(1, …)` 回傳 `0`。
  - 用 H200×8 的副本：`memBytes = 8×141e9`、`memBwBytesPerSec = 8×4.8e12`、`flopsPerSec = 8×1979e12`、`etaBw = 0.7`、`etaCompute = 0.5`，搭配 llama70b、`bpp = 1`、chat（1020/129/0）、`B = 1`、`includeComm: false`：
    - `bwSec` ≈ `(70.55e9 + 1084.5×163840)/(38.4e12×0.7)`（llama70b 沒有 sliding，所以 `kvBytesPerSequence = ctx × 163840`）
    - `computeSec > 0`
    - `stepSec = max(...)`
  - 同一個副本開啟通訊時，`stepSec` 會比關閉時多 `2×80×allReduceSec(...)`。
  - `ttftSec`：assist 工作負載（126180/252/0.957）在 Mac 副本上（flops 66.6e12，etaCompute 1，llama70b）應落在 37～39 秒之間。

- [ ] **Step 2: 執行測試，確認失敗**

- [ ] **Step 3: 實作 `timing.ts`**

- [ ] **Step 4: 執行測試，確認通過**

- [ ] **Step 5: Commit** `git commit -m "feat(core): roofline decode step with prefill interference, TTFT and all-reduce"`

---

### Task 8: 求解器（合法 TP、配置檢查、最少 GPU、容量上限）

**Files:**
- Create: `packages/core/src/concurrency.ts`, `packages/core/src/solve.ts`
- Test: `packages/core/test/solve.test.ts`

**Interfaces:**
- Consumes：Task 7 的所有函數，以及 `loadBundle()`（Task 4，只在測試中使用）
- Produces：
  - `concurrencyFor(n: number, kind: 'chat'|'agent', agentGeneratingShare: number): { generating: number; resident: number }`
  - `legalTpOptions(platformTp: number[], gpusPerNode: number, m: Model): number[]`
    - 保留滿足以下全部條件的 t：
      - `t ≤ gpusPerNode`
      - `heads % t === 0`
      - `kvHeads % t === 0 || t % kvHeads === 0`
    - 這是 vLLM 的規則。實作時要讀 vLLM 原始碼確認，並把查到的檔案位置寫在程式碼註解裡。
  - `type Ctx = { model: Model; bytesPerParam: number; workload: WorkloadIn; kind: 'chat'|'agent'; speed: { minTokPerSec: number; maxTtftSec: number }; agentShare: number; includeComm?: boolean }`
  - `type Shape = { tp: number; replicas: number }`
  - `type Why = 'weights'|'mem'|'bw'|'compute'|'ttft'`
  - `checkShape(ctx: Ctx, platform: ResolvedPlatform, shape: Shape, n: number, eta: 'expected'|'conservative'): { ok: boolean; why: Why|null; tokPerSecPerUser: number; ttftSec: number; residentPerReplica: number; capacityPerReplica: number; step: ReturnType<typeof decodeStep> }`
    - `capacityPerReplica` = `floor((memBytes × memUtil − weightBytes) / kvBytesPerSequence(m, in+out))`
    - 判定瓶頸 `why` 的順序：
      1. 權重放不下 → `'weights'`
      2. `resident > capacity` → `'mem'`
      3. 每人速度低於要求 → `bwSec ≥ computeSec ? 'bw' : 'compute'`
      4. 首字時間超過上限 → `'ttft'`
  - `solveMinGpus(ctx, platform, n, eta): { ok: true; shape: Shape; gpus: number; check } | { ok: false; why: Why|'too-many'; detail: string }`
    - t 依 `legalTpOptions` 由小到大嘗試。
    - 對每個 t，replicas 從 1 往上加到 999，取第一個可行的配置。（2026-10-20 更正，審查：999 上限讓需求計算和容量計算的結論不一致，已改為在 [1, 常駐人數] 二分搜尋最少副本數，不設上限，也不再有 `'too-many'`。）
    - 在所有 t 中取 GPU 總數最少者；GPU 數相同時取 t 較小者。
    - 若最大的 t 下仍放不下權重 → `'weights'`。
    - 若 n=1 時首字時間或速度就已經不達標 → `ok:false`，`why` 依實際原因填寫。
  - `maxConcurrent(ctx, platform, shape, eta): number`：對 n 做二分搜尋，範圍 [1, 1e7]；即使 n=1 也不可行時回傳 0。
  - `maxConcurrentForGpus(ctx, platform, gpus, eta): { n: number; shape: Shape|null }`：列舉所有合法的 t，replicas = `floor(gpus/t)`，取 n 最大者。
  - `ResolvedPlatform`：由 Task 9 的 `resolvePlatform(bundle, id)` 產生，形狀為 `{ id, name, sub, group, unit, gpusPerNode, tpOptions, tdpW: number|null, replicaFor(tp: number, eta): Replica }`。本 Task 的測試先在測試檔中自行組出一個 stub 實作。

- [ ] **Step 1: 寫失敗的測試**

  以下 golden 值來自 demo 的驗證結果，條件為 `includeComm:false`、`kvBytesPerElem 1`、eta `expected`、llama70b FP8、smooth（20 tok/s，5 秒）：

```ts
expect(maxConcurrent(chatCtx, h200, { tp: 8, replicas: 1 }, 'expected')).toBe(311);
expect(maxConcurrent(chatCtx, h100, { tp: 8, replicas: 1 }, 'expected')).toBe(311);
expect(maxConcurrent(chatCtx, gb200, { tp: 4, replicas: 1 }, 'expected')).toBe(393);
expect(solveMinGpus(assistCtx, h200, 15, 'expected')).toMatchObject({ ok: true, gpus: 4, shape: { tp: 2, replicas: 2 } });
expect(solveMinGpus(assistCtx, h100, 15, 'expected')).toMatchObject({ ok: true, gpus: 8 });
expect(solveMinGpus(assistCtx, gb200, 15, 'expected')).toMatchObject({ ok: true, gpus: 4 });
expect(solveMinGpus(chatCtx, gb200, 500, 'expected')).toMatchObject({ ok: true, gpus: 6 });
expect(solveMinGpus(chatCtx, h200, 500, 'expected')).toMatchObject({ ok: true, gpus: 14 });
expect(maxConcurrentForGpus(chatCtx, h200, 16, 'expected').n).toBe(622);
expect(solveMinGpus(assistCtx, mac, 15, 'expected')).toMatchObject({ ok: false, why: 'ttft' });
const macChat = solveMinGpus(chatCtx, mac, 1, 'expected'); expect(macChat).toMatchObject({ ok: false, why: 'bw' });
```

  Review Focus 中的案例：

```ts
expect(solveMinGpus({ ...chatCtx, bytesPerParam: 2, model: llama405 }, h100, 1, 'expected')).toMatchObject({ ok: false, why: 'weights' });
expect(legalTpOptions([1,2,4,8], 8, phi4 /* heads 40, kvHeads 10 */)).toEqual([1, 2]);
expect(legalTpOptions([1,2,4,8], 8, gptoss120)).toEqual([1, 2, 4, 8]);
expect(concurrencyFor(15, 'agent', 0.033)).toEqual({ generating: 1, resident: 15 });
expect(concurrencyFor(500, 'chat', 0.033)).toEqual({ generating: 500, resident: 500 });
```

  若 golden 值和實作差 1，先確認 `capacity` 用的是 `floor`、二分搜尋的邊界是否正確，以及 eta 是否混用了 expected 與 conservative。**不得修改 golden 值去遷就實作**。若確定是 demo 的公式有誤，要在 spec §5 記錄更正，再改 golden 值。

- [ ] **Step 2: 執行測試，確認失敗**：`pnpm vitest run packages/core/test/solve.test.ts`

- [ ] **Step 3: 實作 `concurrency.ts`、`solve.ts`**

- [ ] **Step 4: 執行測試，確認通過**

- [ ] **Step 5: Commit** `git commit -m "feat(core): TP legality, min-GPU solver and capacity search"`

---

### Task 9: 公開 API、計算依據、輸入驗證

**Files:**
- Create: `packages/core/src/basis.ts`, `packages/core/src/api.ts`
- Modify: `packages/core/src/index.ts`（只匯出 api 與型別）
- Test: `packages/core/test/api.test.ts`

**Interfaces:**
- Consumes：`Bundle`（Task 2）、`loadBundle`（Task 4，僅測試用），以及 Task 6～8 的函數
- Produces（spec §9 的 MCP 與網站都會呼叫這些）：

  **輸入**

  - `QueryInput`（zod 驗證）：

  ```
  { model: string | ModelOverride,
    quant: string,
    workload: string | { base: string; inputTokens?: number; outputTokens?: number; cacheHitRate?: number },
    speed: string | { minTokPerSec: number; maxTtftSec: number },
    users?: number }
  ```

    - `users`：正整數，最大 1e7。
    - `outputTokens ≥ 1`
    - `0 ≤ cacheHitRate < 1`

  **函數**

  - `estimateRequirements(bundle, input): RequirementResult`
    - `RequirementResult = { dataVersion; perPlatform: PlatformResult[]; best: string|null; bestCriterion:'fewest-gpus'; basis: BasisItem[]; hasEstimate: boolean; hasUser: boolean }`
    - `PlatformResult = { platform; expected: SolveOut; conservative: SolveOut; maxConcurrent: number; powerKw: number|null; powerNote?: string; verifyCommand: string }`
    - `best`：在 group 為 `nchc`、且 expected 可行的平台中，取 GPU 數最少者。GPU 數相同時，依 `platforms.yaml` 中的順序。
  - `estimateCapacity(bundle, input & { platform: string; gpus: number }): { expected: {n, shape}; conservative: {n, shape}; basis; hasEstimate; hasUser }`
    - （final-review fix，2026-10-20，I3／M15：spec §5.5／§5.6／§9 要求的輸出補齊，計畫與 spec 一致）回傳另帶：`why: Why|null`、`detail?`（n = 0 的原因，含 `'context'`）、`bottleneck: Why|null`（多 1 人時先違反的條件：`'mem'|'bw'|'compute'|'ttft'`；n = 0 時同 `why`；達搜尋上限時為 null）、`memoryOnlyMax`／`memoryOnlyShape`（同樣 GPU 的最佳切法、不套速度目標的記憶體上限人數）、`speedCurve: { shape, points: [{ users, tokPerSecPerUser, aggregateTokPerSec, ttftSec }] } | null`（expected 形狀上 1 到上限之間 8 個人數）、`saturated?: true`／`saturatedNote?`（達 1e7 搜尋上限，「至少」這麼多）、`verifyCommand`／`verifyNote?`（規則同 `estimateRequirements`；n = 0 時在 GPU 數內的最大合法 TP、1 個副本、預期不可行）、`queueing`。
  - `findFeasibleModels(bundle, input & { platform: string; gpus: number }): Array<{ model: string; quant: string; feasible: boolean; why?: string }>`
    - （2026-10-20 更正，審查：每一項另帶 `basis`、`hasEstimate`、`hasUser`，可信度取最弱的輸入，和 `estimateRequirements` 一致。）
    - （final-review fix，2026-10-20，I3）`why` 改為原因代碼（`Why`），文字移到 `detail`；需要的 GPU 超過現有數時，`why` 是現有 GPU 的最佳切法在 `users` 人時先違反的條件。每一項另帶 `bottleneck`、`verifyCommand`／`verifyNote?`（最少 GPU 的形狀，規則同 `estimateRequirements`），有部署時另帶 `gpus`、`maxConcurrent`、`memoryOnlyMax`、`speedCurve`（都在最少 GPU 的形狀上）。實測整個目錄在一個平台上約 20–40 ms，所以直接計算，不做延遲欄位。
  - `explain(bundle, input): { basis: BasisItem[]; formulas: string[] }`：無狀態，給相同輸入就重新計算（spec §10.1）。
  - `verifyCommand(platform, shape, model, workload, n): string`
    - 組出 `vllm bench serve --model <hfRepo> --tensor-parallel-size <tp> --max-concurrency <n> --random-input-len <in> --random-output-len <out> --num-prompts <max(n×10, 100)>`
    - Mac 則回傳以 `mlx_lm` 為基礎、附相同參數的指令說明文字。
  - `BasisItem = { path: string; status: CoreStatus; value: unknown; sourceIds: string[]; text: string }`
    - 收集本次計算實際用到的所有 `Sourced` 欄位。
    - 使用者覆寫的值標為 `status:'user'`。

  **其他規則**

  - `powerKw = gpus × tdpW / 1000`；`tdpW` 為 `null` 時，結果為 `powerKw:null`，並附 `powerNote:'功耗未查證'`。

- [ ] **Step 1: 寫失敗的測試**（使用 `loadBundle()` 載入真實的 bundle）
  - 以 assist、15 人、Llama 3.3 70B FP8、smooth 呼叫 `estimateRequirements`：
    - 若 Llama 3.3 70B 是 gated 模型而沒有匯入，就改用 `ModelOverride`，數值與 Task 6 的 llama70b 相同，並斷言 `hasUser === true`。
    - `best === 'nano4-h200'`。
    - nano4-gb200 的 `powerKw === null` 且 `powerNote` 存在。
    - `hasEstimate === true`。
    - basis 中包含 `workloads.assist.inputTokens`，其 status 為 `measured`。
    - 斷言時要開啟通訊（`includeComm` 為預設值）。台數可能比 Task 8 的 golden 值多，所以只斷言 `gpus ≥ 4` 與 `best` 平台。
  - 輸入驗證：`users: 0`、`users: 1.5`、`users: 2e7`、`workload: { base:'chat', outputTokens: 0 }`、`cacheHitRate: 1`，都必須丟出 `ZodError`。
  - `verifyCommand(...)` 的輸出包含 `--tensor-parallel-size 2` 與 `--max-concurrency 15`。
  - `explain` 對相同輸入呼叫兩次，結果 `toEqual`。

- [ ] **Step 2: 執行測試，確認失敗**：`pnpm vitest run packages/core/test/api.test.ts`

- [ ] **Step 3: 實作 `basis.ts`、`api.ts`**
  - 提供 `resolvePlatform(bundle, id)` 與 `resolveModel(bundle, idOrOverride)`。
  - 這兩個函數在回傳規格的同時，也要回傳本次用到的 BasisItem。

- [ ] **Step 4: 執行全部測試**：`pnpm test && pnpm typecheck` → Expected：全部通過，0 個型別錯誤

- [ ] **Step 5: Commit** `git commit -m "feat(core): public API with provenance basis, input validation and verify command"`

---

### Task 10: 校正報告

**Files:**
- Create: `packages/data/src/calibrate.ts`
- Modify: `config/calibration.yaml`（加入 `points`）、根目錄 `package.json`（新增 `calibrate` script）
- Test: `packages/data/test/calibrate.test.ts`

**Interfaces:**
- Consumes：`CalibrationPoint`（Task 2）、`estimateCapacity` / `checkShape`（Task 8～9）
- Produces：
  - `runCalibration(bundle): Array<{ id; role; metric; measured; predicted; errorPct; withinTolerance: boolean }>`
    - 容忍度：`decodeTokPerSec`、`ttftSec` 為 ±25%；`maxConcurrent` 為 ±10%（spec §10.1）。
  - CLI `pnpm calibrate`：寫出 `packages/data/dist/accuracy.json`。
    - 超出容忍度的 `validate` 點：印出 `WARN` 但退出碼仍為 0。
    - `fit` 點只列入報告，不發出警告。

初始資料點（數值取自 `docs/research/apple-silicon.md` 與 `user-questions.md`，全部為 `measured`）：

| id | role | 條件 | metric | measured |
|---|---|---|---|---|
| `apple-m5u-mistral128b-fp8-8k` | fit | mac-studio-m5u-512, Mistral Medium 3.5 128B dense FP8, in 8192, out 128, hit 0, n=1 | decodeTokPerSec | 7.70 |
| `apple-m5u-mistral128b-fp8-8k-ttft` | validate | 同上 | ttftSec | 24.6 |
| `storagereview-spark-llama8b-fp8-c1` | fit | dgx-spark, Llama 3.1 8B FP8, n=1（輸入/輸出長度取文章設定；文章未載明時列入 skipped） | decodeTokPerSec | 23.2 |
| `storagereview-spark-llama8b-bf16-c1` | validate | dgx-spark, Llama 3.1 8B BF16, n=1（同上） | decodeTokPerSec | 13.6 |
| `storagereview-spark-mistralsmall31-fp8-c1` | validate | dgx-spark, Mistral Small 3.1 24B FP8, n=1（同上） | decodeTokPerSec | 8.8 |

- 前兩個模型需要先透過 Task 5 匯入。若匯入失敗，就把該點移到報告的「skipped」，並附上原因。
- **NVIDIA H100、H200、GB200 目前沒有公開實測點。** `accuracy.json` 必須列出這項缺口（`gaps: ['nvidia-hgx', 'nvidia-gb200']`），等國網實測後補上。

- [ ] **Step 1: 寫失敗的測試**：用 fixture 的兩個資料點，一個在容忍度內、一個在容忍度外，斷言回傳結果的 `withinTolerance` 與 `errorPct` 數值。`errorPct` 的定義為 `(predicted − measured)/measured × 100`。

- [ ] **Step 2: 執行測試，確認失敗**

- [ ] **Step 3: 實作 `calibrate.ts`**，並把資料點寫入 `config/calibration.yaml`

- [ ] **Step 4: 執行測試與 CLI**
  - Run: `pnpm vitest run packages/data/test/calibrate.test.ts && pnpm calibrate`
  - Expected：
    - 測試通過。
    - CLI 印出每一點的 `measured / predicted / errorPct`，並寫出 `dist/accuracy.json`。
    - 退出碼為 0。
  - **把 CLI 輸出貼進 PR 描述**。誤差大的點也要誠實列出，不得為了讓點落在容忍度內而調整 η。調整 η 屬於校正決策，要另外以 `fit` 點為依據並記錄。

- [ ] **Step 5: Commit** `git commit -m "feat(data): calibration report against published measurements"`

---

## 後續計畫（不在本計畫範圍）

- **Plan 2：網站**（spec §8.3.3 v6 版面、Ant Design；必修的「選單狀態互相刷新」回歸測試）
- **Plan 3：MCP**（spec §9，stdio 與 Streamable HTTP）
- **Plan 4：自訂能力**（瀏覽器端 HF 匯入、自訂模型 / 工作 / 速度、總人數漏斗輔助）
- **Plan 5：引用匯出、專家檢視、準確度頁**
- **跨 node / 多台 Mac / 多台 DGX Spark 切分**（PP、TB5 RDMA、ConnectX-7）：spec §5.4，待以上完成後評估
- **本計畫刻意延後的 spec 項目**（各自歸入上列計畫）：
  - `config/capability/`：能力等級與評測依據。本計畫先以 workload 的 `tierNote`（estimate）代替，延到 Plan 4。
  - `config/demand/`：總人數漏斗，延到 Plan 4。
  - P95 / P99 餘裕係數（spec §12），延到 Plan 5，並同時處理準確度頁。
  - 推論引擎切換（vLLM / SGLang / MLX / llama.cpp 各自的效率係數，spec §10.1）。本計畫每個平台只有一組預設 calibration profile，延到 Plan 4。
