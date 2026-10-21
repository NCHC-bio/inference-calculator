# 網站主畫面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做出 spec §8.3.3 v6 定案版面的純靜態網站：一句填空句輸入，「我需要多少」／「我已有的能撐多少」兩種模式，每個平台一列的答案、點開的細節與計算依據。所有數字都來自 `@nchc/core`。

**Architecture:** 新增 `packages/web`（Vite + React + TypeScript + Ant Design，圖示與動畫用 D3）。

- 網站在 build 時把 `packages/data/dist/bundle.json` 打包進去，在瀏覽器內直接呼叫 core 的 API，不需要後端。
- 輸入狀態集中在一個 reducer，並同步到網址，方便分享。
- 網站本身不實作任何公式（spec §10「網站與 MCP 都不得自行實作公式」）。v6 細節面板需要的使用率與記憶體組成，先在 Task 1 由 core 輸出。

**Tech Stack:** React 19.3.0、antd 6.6.5、@ant-design/icons 6.3.4、Vite 8.3.3、@vitejs/plugin-react 6.1.2、d3-selection 3.0.0、d3-transition 3.0.1、d3-scale 4.0.2、Vitest（沿用根目錄的 5.0.3）、@testing-library/react 16.3.3、@testing-library/user-event 14.6.7、jsdom 30.1.2、Playwright（Task 10 查版本）。

**Spec:** `docs/superpowers/specs/2026-10-19-inference-calculator-design.md`（下文以「spec §x」引用）。版面草稿：`docs/prototypes/calculator-demo-v7.html`（以下稱「v7 草稿」）。上一份計畫：`docs/superpowers/plans/2026-10-19-core-and-config.md`。

**範圍**：spec §10.2 排序中的第 2 項「網站主畫面」。以下各項不在本計畫內：

- MCP：第 3 項。
- Hugging Face 匯入，以及工作、速度選單的「自訂…」：第 4 項。
- ⧉ 引用與專家檢視：第 5 項。
- 準確度頁（spec §10.1）。
- 人數漏斗換算（spec §4.3）。
- 成本：設定檔目前沒有費率。

v6 第一眼要有「⧉ 引用」按鈕。本計畫先放上按鈕但設為停用，提示文字寫「即將推出」，第 5 項再接上功能（**計畫者判斷**）。

## Global Constraints

- **資料誠信（spec §2.1、§8.2）**：
  - 畫面上每個數字都必須來自 core 的回傳值或 bundle 的設定值。
  - `packages/web` 中不得出現任何硬體、模型、負載數值，也不得有公式；測試 fixture 例外。
  - 用到推估值時一律標「推估」（`hasEstimate`），用到自訂值時標「自訂」（`hasUser`）。
- **v6 版面（spec §8.3.3）**：
  - 第一眼只顯示四樣東西：模式切換、一行完整的填空句、一行答案、每個平台一列。其他資訊一律點開才出現。
  - **必須保留完整句子**，不能縮減成以「·」分隔的欄位。句型是：「同時最多有 `[人數]` 人會使用，做 `[工作 ▾]` 任務，模型用 `[模型（可搜尋）]`，模型精度用 `[量化 ▾]`，希望回應速度 `[速度 ▾]`」。
  - 「我已有」模式的句子開頭改為「我有 `[數量]` `[張／台]` `[平台 ▾]`，…」。
  - 只是在確認「符合你的要求」的資訊不顯示。例如可行的列不列出速度數字。
- **說明一律用 Popover／Tooltip**：
  - 觸發方式要同時支援 hover、點擊／觸控與鍵盤焦點。
  - 下拉選項的說明：桌面上移過或用鍵盤移到選項時顯示；`(hover: none)` 的裝置上直接顯示在選項名稱下方。
- **使用者的單位（spec §8.2-3）**：主畫面用「張」「台」「人」「秒」「每秒字數」，不用 tok/s、TPOT、KV。工程單位只放在 popover 與依據面板。
- **狀態（spec §8.3.3 demo 已知缺陷）**：
  - 所有輸入一律做成受控元件，狀態集中在單一 reducer。
  - 元件不可定義在其他元件內部。
  - 每個選單的變更不得改動其他選單的值。唯一的例外是 Task 3 的量化自動校正。
- **AntD 注意事項**：
  - `Progress` 一律設 `status="normal"`，避免到 100% 時自動變綠。
  - 兩個字的中文按鈕要設 `ConfigProvider button={{ autoInsertSpace: false }}`。
- **動畫（spec §8.3.1-4、§8.2-5）**：
  - 只在輸入改變時觸發，每次 400 ms，同一組物件一起動、不錯開。
  - 台數改變時，前一狀態以殘影保留一次轉場。
  - `prefers-reduced-motion: reduce` 時動畫時長為 0。
  - 圖表與動畫一律用 D3，React 只負責表單與版面（spec §8.4）。
- **深色模式**：跟隨 `prefers-color-scheme`，套用 antd 的 `theme.darkAlgorithm`。D3 的顏色一律取自 antd token，不寫死色碼。
- **語系（spec §8.4）**：
  - 介面文案集中在 `src/i18n/zh-TW.ts` 與 `src/i18n/en.ts`，網址參數 `lang` 決定語系，預設 `zh-TW`。
  - 設定檔與 core 產生的文字（名稱、description、`detail`、basis `text`）目前只有中文，本計畫照原文顯示。雙語欄位要另外改 schema 與 core，留給後續計畫（**計畫者判斷**；交付時要向使用者說明）。
- **套件版本**：Tech Stack 中的版本是 2026-10-21 查 npm registry 得到的結果，條件是發布滿兩週的最新穩定版。安裝時照這些版本釘死確切版本。只有 Tech Stack 中沒列出的套件（Playwright、@testing-library/jest-dom）才在使用時依同一規則查詢。
- **不得引入紅色供應鏈模型**：見 spec §2.2。網站只顯示 bundle 中的模型目錄。

## Review Focus

1. **所有國網機台都不可行**（例如 `mistral-medium-3.5-128b`、`bf16`、研究助理、10 萬人）：
   - core 回傳 `best = null`。答案行要顯示「國網機台都不可行」，下一行提示「可嘗試較小的模型、較低精度或放寬速度」。
   - 每一列各自顯示不可行的原因，不可白屏或報錯。
   - 測試放在 Task 6。
2. **網址參數是亂碼、未知的 id 或超出範圍的數字**（`?n=0`、`?n=1e9`、`?n=abc`、`?m=no-such-model`、`?q=int4-awq` 搭配不支援它的模型）：
   - 不合法的欄位逐一退回預設值，其他合法的欄位保留。
   - 不可丟出錯誤。
   - 測試放在 Task 3。
3. **人數欄被清空，或輸入 0、小數、超過 10⁷**：
   - reducer 只接受 1 到 10⁷ 的整數。不合法時保留上一個合法值，core 永遠不會收到不合法的輸入。
   - 萬一 core 仍丟出 `CoreInputError`，結果區要顯示錯誤訊息，不可讓整頁崩潰。
   - 測試放在 Task 4、Task 5。
4. **GB200 的 TDP 是 null**：細節面板的功耗要顯示「功耗未查證」，並附 core 的 `powerNote`。不可以是 NaN、0 或空白。測試放在 Task 8。
5. **觸控裝置**（`matchMedia('(hover: none)')` 為 true）：
   - 下拉選項的說明直接顯示在選項名稱下方。
   - 「推估」標記、不可行原因、容量條點一下就打開 popover。
   - 測試放在 Task 5、Task 7。

---

## File Structure

```
packages/core/src/solve.ts          ← 新增 shapeUsage
packages/core/src/api.ts            ← PlatformResult / CapacityResult 加 usage；新增 quantOptions
packages/core/src/index.ts          ← 匯出新增的型別與函式
vitest.config.ts                    ← 改用 projects：node 套件 + web（jsdom）
package.json                        ← 新增 web:dev / web:build / web:e2e scripts
packages/web/
  package.json  tsconfig.json  vite.config.ts  vitest.config.ts  index.html  playwright.config.ts
  src/main.tsx                      ← 掛載 <App/>
  src/App.tsx                       ← ConfigProvider、版面骨架
  src/bundle.ts                     ← 讀取並驗證 bundle
  src/theme.ts                      ← 深色模式偵測、antd theme
  src/motion.ts                     ← 動畫時長、reduced-motion
  src/i18n/{index.ts,zh-TW.ts,en.ts}
  src/state/{state.ts,url.ts,store.tsx}
  src/compute/{compute.ts,useResults.ts}
  src/components/
    Explain.tsx                     ← hover + 點擊 + 焦點三種觸發的 popover
    OptionSelect.tsx                ← 選項附說明的 Select
    Sentence.tsx  AnswerLine.tsx  BasisDrawer.tsx
    PlatformList.tsx  PlatformRow.tsx  Isotype.tsx  CapacityBar.tsx
    RowDetail.tsx  TypingDemo.tsx  UsageBars.tsx  MemoryBar.tsx
    HaveResult.tsx
  test/setup.ts  test/*.test.ts(x)
  e2e/smoke.spec.ts
```

---

### Task 1: core 輸出使用率、記憶體組成與量化選項

**Files:**
- Modify: `packages/core/src/solve.ts`（新增 `shapeUsage`，放在 `checkShape` 之後）
- Modify: `packages/core/src/api.ts`：`PlatformResult`、`CapacityResult` 加 `usage`；新增 `quantOptions`；`findFeasibleModels` 改用它
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/api.test.ts`、`packages/core/test/solve.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** One replica of `shape` at n users (spec §8.3.3 細節面板; v7 草稿 DetailT 的四根使用率條). */
  export type ShapeUsage = {
    shape: Shape;
    /** Bytes per replica: usable = memBytes × memUtil; kv = residentPerReplica × kvSizing.perSeq. */
    memory: { usableBytes: number; weightsBytes: number; kvBytes: number; reserveBytes: number; perUserKvBytes: number; residentPerReplica: number };
    /** 1 = at the limit. mem = (weights + reserve + kv) / usable; bw = step.bwSec / step.stepSec;
     *  compute = step.computeSec / step.stepSec; ttft = ttftSec / speed.maxTtftSec. */
    share: { mem: number; bw: number; compute: number; ttft: number };
    tokPerSecPerUser: number;
    ttftSec: number;
  };
  export function shapeUsage(ctx: Ctx, platform: ResolvedPlatform, shape: Shape, n: number, eta: EtaMode): ShapeUsage;
  // PlatformResult.usage: ShapeUsage | null    （expected shape、n = users；expected.ok 為 false 時是 null）
  // CapacityResult.usage: ShapeUsage | null    （expected shape、n = expected.n；n = 0 時是 null）
  /** Quantization ids the UI offers for a catalog model: [nativeQuant.quant] for a natively quantized checkpoint,
   *  else every quantization without vllmServe.nativeOnly (bundle order). The rule findFeasibleModels evaluates. */
  export function quantOptions(bundle: Bundle, modelId: string): string[];
  ```
  bw 與 compute 的定義採用 v7 草稿：佔每步時間的比例。四個比例取最大的那個作為瓶頸。

- [ ] **Step 1: 寫失敗的測試**（`api.test.ts`，沿用檔案內的 `realBundle()`）

```ts
describe('usage (spec §8.3.3 細節面板)', () => {
  const b = realBundle();
  const q = { model: 'llama-3.3-70b-instruct-fp8', quant: 'fp8', workload: 'assist', speed: 'smooth', users: 15 } as const;
  it('feasible platform: usage matches its expected shape and stays within the limits', () => {
    const r = estimateRequirements(b, q).perPlatform.find((p) => p.platform === 'nano4-h200')!;
    expect(r.expected.ok).toBe(true);
    const u = r.usage!;
    expect(u.shape).toEqual(r.expected.ok && r.expected.shape);
    expect(u.tokPerSecPerUser).toBeCloseTo(r.expected.ok ? r.expected.check.tokPerSecPerUser : NaN, 9);
    expect(u.ttftSec).toBeCloseTo(r.expected.ok ? r.expected.check.ttftSec : NaN, 9);
    expect(u.memory.weightsBytes + u.memory.reserveBytes + u.memory.kvBytes).toBeLessThanOrEqual(u.memory.usableBytes);
    for (const s of Object.values(u.share)) { expect(s).toBeGreaterThanOrEqual(0); expect(s).toBeLessThanOrEqual(1); }
  });
  it('infeasible platform: usage is null', () => {
    const r = estimateRequirements(b, { ...q, model: 'mistral-medium-3.5-128b', quant: 'bf16' })
      .perPlatform.find((p) => p.platform === 'mac-mini-m6-32')!;
    expect(r.expected.ok).toBe(false);
    expect(r.usage).toBeNull();
  });
  it('capacity: usage at expected.n, null when nobody fits', () => {
    const { users: _u, ...cq } = q;
    const c = estimateCapacity(b, { ...cq, platform: 'nano4-h200', gpus: 8 });
    expect(c.usage!.memory.residentPerReplica).toBeGreaterThan(0);
    const none = estimateCapacity(b, { ...cq, model: 'mistral-medium-3.5-128b', quant: 'bf16', platform: 'mac-mini-m6-32', gpus: 1 });
    expect(none.expected.n).toBe(0);
    expect(none.usage).toBeNull();
  });
});
describe('quantOptions', () => {
  const b = realBundle();
  it('matches the quantizations findFeasibleModels evaluates, per model', () => {
    const items = findFeasibleModels(b, { workload: 'chat', speed: 'ok', platform: 'nano4-h200', gpus: 8 });
    for (const id of Object.keys(b.models)) {
      expect(quantOptions(b, id)).toEqual(items.filter((x) => x.model === id).map((x) => x.quant));
    }
  });
  it('unknown model → CoreInputError unknown-id', () => {
    expect(() => quantOptions(b, 'no-such')).toThrow(CoreInputError);
  });
});
```

`estimateCapacity` 的輸入沒有 `users`，所以上面用解構拿掉它。不要改成傳 `users: undefined`，strict schema 會拒絕。

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pnpm vitest run packages/core/test/api.test.ts -t "usage|quantOptions"`
Expected: FAIL，錯誤訊息是 `usage` 為 undefined，或 `quantOptions is not a function`。

- [ ] **Step 3: 實作**
  - `shapeUsage` 呼叫 `checkShape` 拿 step、ttft 與 residentPerReplica，再用 `ctxWeightBytes` 與 `kvSizing` 組出記憶體欄位，不重算公式。
  - JSDoc 寫出 spec §8.3.3 與 lecRef（記憶體部分是 B3）。
  - `estimateRequirements` 與 `estimateCapacity` 填入 `usage`。
  - `findFeasibleModels` 的 `ids` 改成呼叫 `quantOptions`（指定了 `input.quant` 時照舊）。
  - 從 `index.ts` 匯出 `shapeUsage`、`quantOptions`、`ShapeUsage`、`CapacityResult`、`SpeedCurve`。

- [ ] **Step 4: 跑全部測試與型別檢查**

Run: `pnpm test && pnpm typecheck`
Expected: 全部 PASS（原本 461 個加上新增的測試），型別檢查沒有錯誤。

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): expose per-shape usage and quantization options for the web detail panel"
```

---

### Task 2: web 套件骨架、bundle、主題、語系、測試環境

**Files:**
- Create: `packages/web/{package.json,tsconfig.json,vite.config.ts,vitest.config.ts,index.html}`
- Create: `packages/web/src/{main.tsx,App.tsx,bundle.ts,theme.ts,motion.ts}`
- Create: `packages/web/src/i18n/{index.ts,zh-TW.ts,en.ts}`
- Create: `packages/web/test/{setup.ts,app.test.tsx,motion.test.ts}`
- Modify: `vitest.config.ts`、根目錄 `package.json`

**Interfaces:**
- Consumes: `BundleSchema`、`Bundle`（`@nchc/schema`）
- Produces:
  ```ts
  // bundle.ts —— bundle.json 只在這裡 import，由 BundleSchema.parse 驗證一次並快取
  export function getBundle(): Bundle;
  // i18n/index.ts
  export type Lang = 'zh-TW' | 'en';
  export type MsgKey = keyof typeof zhTW;   // en.ts 必須 satisfies Record<MsgKey, string>
  export function t(lang: Lang, key: MsgKey, vars?: Record<string, string | number>): string;   // 以 {name} 插值
  export type TFn = (key: MsgKey, vars?: Record<string, string | number>) => string;
  export const tZh: TFn;      // t('zh-TW', …)，供測試與非 React 程式使用
  export function useT(): TFn;  // Task 2 先讀網址的 lang 參數；Task 3 改為從 store 取得
  // theme.ts
  export function useDarkMode(): boolean;     // matchMedia('(prefers-color-scheme: dark)')，會跟著系統設定變化
  export function antdTheme(dark: boolean): ThemeConfig;
  // motion.ts
  export const TRANSITION_MS = 400;
  export function transitionMs(): number;     // reduced-motion 時回傳 0
  ```

- [ ] **Step 1: 設定**
  - `packages/web/package.json`：
    - `"name": "@nchc/web"`，`private`，`type: module`。
    - dependencies：`@nchc/core`、`@nchc/schema`，以及 Tech Stack 列出的版本。
    - scripts：`"dev": "pnpm -w data:build && vite"`、`"build": "pnpm -w data:build && vite build"`、`"preview": "vite preview"`。
  - 根目錄 `package.json` 新增：`"web:dev": "pnpm --filter @nchc/web dev"`、`"web:build": "pnpm --filter @nchc/web build"`。
  - `vite.config.ts`：`base: './'`，讓網站可以放在任意子路徑下當靜態檔。
  - `tsconfig.json`：
    - extends base，加 `"jsx": "react-jsx"`、`"lib": ["ES2023","DOM","DOM.Iterable"]`、`"types": ["vite/client"]`、`"resolveJsonModule": true`。
    - references 指向 core 與 schema。
  - 根目錄 `vitest.config.ts` 改成 `test.projects`，包含兩個 project：
    - `{ test: { name: 'node', include: ['packages/{core,data,schema}/test/**/*.test.ts'] } }`
    - `'packages/web/vitest.config.ts'`：`name: 'web'`，`environment: 'jsdom'`，`include: ['test/**/*.test.{ts,tsx}']`，`setupFiles: ['test/setup.ts']`。
  - `test/setup.ts` 提供可切換的 `matchMedia` mock（`setMedia({ dark?, reducedMotion?, hoverNone? })`），並載入 `@testing-library/jest-dom/vitest`。

- [ ] **Step 2: 寫失敗的測試**

```tsx
// app.test.tsx
it('renders the mode switch and a data version from the bundle', () => {
  render(<App />);
  expect(screen.getByText('我需要多少')).toBeInTheDocument();
  expect(screen.getByText('我已有的能撐多少')).toBeInTheDocument();
  expect(screen.getByText(new RegExp(getBundle().meta.dataVersion))).toBeInTheDocument();
});
it('?lang=en switches UI copy', () => {
  history.replaceState(null, '', '/?lang=en');
  render(<App />);
  expect(screen.getByText(t('en', 'mode.need'))).toBeInTheDocument();
});
// motion.test.ts
it('reduced motion → 0 ms, otherwise 400', () => {
  setMedia({ reducedMotion: true }); expect(transitionMs()).toBe(0);
  setMedia({ reducedMotion: false }); expect(transitionMs()).toBe(400);
});
it('every zh-TW key exists in en', () => { expect(Object.keys(en).sort()).toEqual(Object.keys(zhTW).sort()); });
```

這個任務的 `App` 只有模式切換與頁尾的「資料版本 {dataVersion}」。英文版的 `mode.need` 是 `How much do I need`。

- [ ] **Step 3: 執行測試，確認失敗**

Run: `pnpm vitest run --project web`
Expected: FAIL，因為模組還不存在。

- [ ] **Step 4: 實作上述 Interfaces**
  - `App` 包在 `ConfigProvider` 裡，設定 `theme={antdTheme(dark)}`、`button={{ autoInsertSpace: false }}`、`locale`（antd 的 zh_TW 或 en_US），外面再包 `<AntApp>`。

- [ ] **Step 5: 驗證**

Run: `pnpm vitest run --project web && pnpm test && pnpm typecheck && pnpm web:build`
Expected:
- 全部 PASS。
- `packages/web/dist/index.html` 存在。
- `pnpm --filter @nchc/web preview` 打開後，頁面能顯示模式切換。

- [ ] **Step 6: Commit**

```bash
git add packages/web vitest.config.ts package.json pnpm-lock.yaml
git commit -m "feat(web): scaffold Vite + React + antd site with bundle, theme, i18n and test setup"
```

---

### Task 3: 狀態 reducer 與網址同步

**Files:**
- Create: `packages/web/src/state/{state.ts,url.ts,store.tsx}`
- Test: `packages/web/test/state.test.ts`、`packages/web/test/url.test.ts`

**Interfaces:**
- Consumes: `getBundle()`、`quantOptions(bundle, modelId)`
- Produces:
  ```ts
  export type Mode = 'need' | 'have';
  export type CalcState = {
    mode: Mode; lang: Lang;
    users: number;            // 「需要多少」模式的同時最多人數，1..1e7 的整數
    haveCount: number;        // 「我已有」模式的張數或台數，1..1e5 的整數
    havePlatform: string;
    workload: string; model: string; quant: string; speed: string;
    openRow: string | null;   // 目前展開的平台 id
    basisOpen: boolean;
  };
  export type Action =
    | { type: 'mode'; mode: Mode } | { type: 'lang'; lang: Lang }
    | { type: 'users'; value: number | null } | { type: 'haveCount'; value: number | null }
    | { type: 'havePlatform'; id: string } | { type: 'workload'; id: string } | { type: 'model'; id: string }
    | { type: 'quant'; id: string } | { type: 'speed'; id: string }
    | { type: 'openRow'; id: string | null } | { type: 'basis'; open: boolean };
  export function defaultState(bundle: Bundle): CalcState;
  export function reduce(bundle: Bundle, s: CalcState, a: Action): CalcState;
  export function encodeUrl(s: CalcState): string;                       // 輸出 query string；openRow 與 basisOpen 不寫進網址
  export function decodeUrl(bundle: Bundle, search: string): CalcState;  // 從 defaultState 開始，逐一套用合法的欄位
  export function StoreProvider(props: { children: ReactNode }): JSX.Element;
  export function useCalc(): [CalcState, (a: Action) => void];
  ```
  - 網址參數鍵：`mode`、`lang`、`n`、`have`、`hp`、`w`、`m`、`q`、`s`。
  - 預設值取 v7 草稿：`need`、15 人、研究助理 `assist`、`llama-3.3-70b-instruct-fp8`、`quant = quantOptions(...)[0]`、`smooth`，「我已有」為 16 張 `nano4-h200`。這些 id 寫在 `state.ts` 的 `DEFAULTS` 常數裡。啟動時要確認每個 id 都在 bundle 中，不在的話退回該集合的第一個 id。這是介面預設選項，不是數值，不違反「不寫死數值」的規則。
  - store 每次 dispatch 後呼叫 `history.replaceState(null, '', '?' + encodeUrl(s))`。

- [ ] **Step 1: 寫失敗的測試**

```ts
// state.test.ts
const b = getBundle(); const s0 = defaultState(b);
it('each select changes only its own field (spec §8.3.3 demo 缺陷)', () => {
  const s1 = reduce(b, s0, { type: 'speed', id: 'ok' });
  expect({ ...s1, speed: s0.speed }).toEqual(s0);
  const s2 = reduce(b, s1, { type: 'workload', id: 'chat' });
  expect(s2.speed).toBe('ok'); expect(s2.model).toBe(s0.model); expect(s2.quant).toBe(s0.quant);
});
it('users: rejects null, 0, decimals, > 1e7; keeps the last valid value', () => {
  for (const v of [null, 0, 2.5, -3, 1e7 + 1, Number.NaN]) expect(reduce(b, s0, { type: 'users', value: v }).users).toBe(s0.users);
  expect(reduce(b, s0, { type: 'users', value: 200 }).users).toBe(200);
});
it('model change keeps quant when the new model offers it, else takes its first option', () => {
  const native = reduce(b, s0, { type: 'model', id: 'gpt-oss-120b' });
  expect(native.quant).toBe(quantOptions(b, 'gpt-oss-120b')[0]);
});
it('unknown ids are ignored', () => {
  expect(reduce(b, s0, { type: 'model', id: 'no-such' })).toEqual(s0);
});
// url.test.ts
it('round-trips every field', () => {
  const s = { ...s0, mode: 'have' as const, lang: 'en' as const, users: 321, haveCount: 4, havePlatform: 'nano5-h100', workload: 'chat', speed: 'ok' };
  expect(decodeUrl(b, encodeUrl(s))).toEqual(s);
});
it.each(['n=0', 'n=1e9', 'n=abc', 'n=2.5', 'm=no-such-model', 'mode=x', 'lang=fr', 'hp=nope', 'have=-1'])('bad %s → default for that field, no throw', (q) => {
  expect(decodeUrl(b, '?' + q + '&s=ok')).toEqual({ ...s0, speed: 'ok' });
});
it('q the model does not offer → the model\'s first option', () => {
  const s = decodeUrl(b, '?m=gpt-oss-120b&q=bf16');
  expect(quantOptions(b, 'gpt-oss-120b')).toContain(s.quant);
});
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pnpm vitest run --project web test/state.test.ts test/url.test.ts`
Expected: FAIL，因為模組還不存在。

- [ ] **Step 3: 實作上述 Interfaces**
  - 量化的處理方式：如果新模型的 `quantOptions` 包含目前的量化就保留，否則改用它的第一個選項。這是唯一會跨欄位改值的規則。
  - `decodeUrl` 先處理 `m`，再處理 `q`。

- [ ] **Step 4: 執行測試，確認通過**

Run: `pnpm vitest run --project web`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/state packages/web/test
git commit -m "feat(web): central calculator state with URL sync and input guards"
```

---

### Task 4: 計算層

**Files:**
- Create: `packages/web/src/compute/{compute.ts,useResults.ts}`
- Test: `packages/web/test/compute.test.ts`

**Interfaces:**
- Consumes: `CalcState`、`estimateRequirements`、`estimateCapacity`、`quantOptions`、`CoreInputError`、`RequirementResult`、`CapacityResult`
- Produces:
  ```ts
  export type NeedView = { kind: 'need'; result: RequirementResult };
  export type HaveView = { kind: 'have'; result: CapacityResult };
  export type ErrorView = { kind: 'error'; message: string };   // 只有 CoreInputError 會轉成這個；其他 Error 照常丟出
  export type View = NeedView | HaveView | ErrorView;
  export function computeView(bundle: Bundle, s: CalcState): View;
  /** 模型選單「可在 X 種機台上執行」：以目前的人數、工作、速度計算；量化取目前的值（如果該模型提供），
   *  否則取它的第一個選項；計算 expected.ok 的平台數。 */
  export function modelFeasibility(bundle: Bundle, s: CalcState): Record<string, { ok: number; total: number }>;
  export function useView(): View;                                          // useMemo 依賴相關欄位，搭配 useDeferredValue
  export function useModelFeasibility(enabled: boolean): Record<string, { ok: number; total: number }> | null;  // 只在模型選單打開時計算
  ```

- [ ] **Step 1: 寫失敗的測試**

```ts
const b = getBundle(); const s0 = defaultState(b);
it('need mode returns estimateRequirements for the state', () => {
  const v = computeView(b, s0);
  expect(v.kind).toBe('need');
  expect(v.kind === 'need' && v.result).toEqual(estimateRequirements(b, { model: s0.model, quant: s0.quant, workload: s0.workload, speed: s0.speed, users: s0.users }));
});
it('have mode returns estimateCapacity for havePlatform × haveCount', () => {
  const v = computeView(b, { ...s0, mode: 'have' });
  expect(v.kind === 'have' && v.result.expected.n).toBeGreaterThan(0);
});
it('CoreInputError → error view, not a throw', () => {
  expect(computeView(b, { ...s0, users: 0 }).kind).toBe('error');
});
it('modelFeasibility covers every catalog model and counts every platform', () => {
  const f = modelFeasibility(b, s0);
  expect(Object.keys(f).sort()).toEqual(Object.keys(b.models).sort());
  for (const x of Object.values(f)) expect(x.total).toBe(Object.keys(b.platforms).length);
});
it('modelFeasibility over the whole catalog runs under 1.5 s', () => {
  const t = performance.now(); modelFeasibility(b, s0); expect(performance.now() - t).toBeLessThan(1500);
});
```

最後一項測的是：模型選單打開時，在主執行緒上的計算時間可以接受。如果超過 1.5 秒，就停下來回報。不要擅自改用 Web Worker，這是架構變更。

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pnpm vitest run --project web test/compute.test.ts`
Expected: FAIL

- [ ] **Step 3: 實作上述 Interfaces**

- [ ] **Step 4: 執行測試，確認通過**

Run: `pnpm vitest run --project web`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/compute packages/web/test/compute.test.ts
git commit -m "feat(web): compute layer over the core API"
```

---

### Task 5: 填空句與附說明的選單

**Files:**
- Create: `packages/web/src/components/{Explain.tsx,OptionSelect.tsx,Sentence.tsx}`
- Modify: `packages/web/src/App.tsx`、`src/i18n/*`
- Test: `packages/web/test/sentence.test.tsx`、`packages/web/test/explain.test.tsx`

**Interfaces:**
- Consumes: `useCalc()`、`useT()`、`useModelFeasibility(enabled)`、`quantOptions`、`getBundle()`
- Produces:
  ```tsx
  /** hover、點擊／觸控、鍵盤焦點都會打開；子元素必須可以取得焦點（沒有的話包一層 tabIndex=0）。 */
  export function Explain(props: { title?: ReactNode; content: ReactNode; children: ReactElement }): JSX.Element;
  export type Opt = { value: string; label: string; desc?: string };
  export function OptionSelect(props: { value: string; options: Opt[]; onChange: (v: string) => void;
    ariaLabel: string; showSearch?: boolean; width?: number; onOpenChange?: (open: boolean) => void }): JSX.Element;
  export function Sentence(): JSX.Element;
  ```
  - 選項說明的來源：
    - 工作：`workload.description`
    - 速度：`speedPreset.description`
    - 平台：`${platform.name}（${platform.sub}）`
    - 模型：`可在 {ok} / {total} 種機台上執行`；`ok = 0` 時顯示「目前設定下所有機台都跑不動」
    - 量化：`quantization` 的名稱
  - 模型選單上方用一行顯示目前工作的 `tierNote.value`，附「推估」標記，提供建議的模型等級（spec §8.3.3「模型選單：建議的模型等級」）。
  - `OptionSelect` 的說明行為：
    - `(hover: none)` 時，`optionRender` 直接把說明顯示在名稱下方。
    - 否則用 `Tooltip` 包住選項。滑鼠移過，或鍵盤移到該選項（antd 的 active 狀態）時顯示。

- [ ] **Step 1: 寫失敗的測試**

```tsx
it('keeps the full sentence (spec §8.3.3: no "·" fields)', () => {
  render(<App />);
  const text = screen.getByTestId('sentence').textContent!;
  for (const part of ['同時最多有', '人會使用，', '做', '任務，', '模型用', '模型精度用', '希望回應速度']) expect(text).toContain(part);
});
it('operating each select in turn leaves the others unchanged (spec §8.3.3 demo 缺陷)', async () => {
  render(<App />); const u = userEvent.setup();
  const pick = async (label: string, option: string) => { await u.click(screen.getByLabelText(label)); await u.click(await screen.findByTitle(option)); };
  await pick('工作', '一般對話問答'); await pick('速度', '可接受');
  await pick('模型', getBundle().models['gpt-oss-120b']!.name);
  expect(screen.getByLabelText('工作')).toHaveTextContent('一般對話問答');   // 斷言目標是 Select 的 selection item
  expect(screen.getByLabelText('速度')).toHaveTextContent('可接受');
});
it('typing an invalid user count keeps the last valid value', async () => {
  render(<App />); const u = userEvent.setup(); const n = screen.getByLabelText('同時人數');
  await u.clear(n); await u.type(n, '0'); await u.tab();
  expect(new URLSearchParams(location.search).get('n')).toBe('15');
});
it('have mode starts with 我有 … and a platform select', async () => {
  render(<App />); await userEvent.click(screen.getByText('我已有的能撐多少'));
  expect(screen.getByTestId('sentence').textContent).toMatch(/^我有/);
  expect(screen.getByLabelText('平台')).toBeInTheDocument();
});
it('touch devices show option descriptions inline', async () => {
  setMedia({ hoverNone: true }); render(<App />);
  await userEvent.click(screen.getByLabelText('工作'));
  expect(await screen.findByText(getBundle().workloads.chat!.description)).toBeVisible();
});
// explain.test.tsx
it.each(['hover', 'click', 'focus'] as const)('opens on %s', async (how) => {
  render(<Explain content="說明"><button>x</button></Explain>); const u = userEvent.setup(); const el = screen.getByText('x');
  if (how === 'hover') await u.hover(el); else if (how === 'click') await u.click(el); else el.focus();
  expect(await screen.findByText('說明')).toBeVisible();
});
```

選取 antd Select 選項的方式（例如 `findByTitle`、`role="option"`）依 antd 6 的實際 DOM 調整。斷言內容不可以改。

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pnpm vitest run --project web test/sentence.test.tsx test/explain.test.tsx`
Expected: FAIL

- [ ] **Step 3: 實作上述 Interfaces**
  - 人數用 `InputNumber`，範圍 1 到 1e7，`precision={0}`。在 `onChange` 時 dispatch，交給 reducer 拒絕不合法的值；blur 時把顯示值同步回 state。
  - 所有元件都定義在模組頂層。

- [ ] **Step 4: 執行測試，確認通過**

Run: `pnpm vitest run --project web`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web
git commit -m "feat(web): fill-in sentence with described selects and accessible popovers"
```

---

### Task 6: 答案行與計算依據面板

**Files:**
- Create: `packages/web/src/components/{AnswerLine.tsx,BasisDrawer.tsx}`
- Modify: `App.tsx`、`src/i18n/*`
- Test: `packages/web/test/answer.test.tsx`

**Interfaces:**
- Consumes: `useView()`、`useCalc()`、`Explain`、`BasisItem`、`bundle.sources`、`bundle.platforms`
- Produces:
  ```tsx
  export function AnswerLine(): JSX.Element;
  export function BasisDrawer(): JSX.Element;   // 由 state.basisOpen 控制
  /** 主答案的文字，供 AnswerLine 與 e2e 使用。 */
  export function needAnswerText(r: RequirementResult, bundle: Bundle, t: TFn): { main: string; sub: string };
  ```
  - 「需要多少」模式，`best` 存在時：
    - `main` = `{name} × {gpus} {張|台}`，後接 `{sub}`。總數達到或超過 `gpusPerNode` 時，再加上 ` · 約 {gpus/gpusPerNode} 個 node`，小數保留 1 位，整除時不顯示小數（spec §10.2）。
    - `sub` = `保守 × {conservative.gpus} {張|台}`；保守估計也不可行時顯示 `保守 —`。
  - `best = null` 時：`main` = `國網機台都不可行`，`sub` = `可嘗試較小的模型、較低精度或放寬速度`。
  - 「我已有」模式：
    - `main` = `同時最多 {expected.n} 人`；`saturated` 時顯示 `同時至少 {expected.n} 人`，並附 `saturatedNote`。
    - `sub` = `保守 {conservative.n} 人`。
    - `n = 0` 時，`main` 顯示紅字「不可行」，`sub` 顯示 `detail`。
  - `ErrorView` 時，用 antd `Alert type="error"` 顯示 `message`。
  - 數字一律用 `Intl.NumberFormat(lang)` 格式化。
  - 標記與按鈕：
    - `hasEstimate` 時顯示「推估」Tag。它用 `Explain` 包住，popover 列出 `status === 'estimate'` 的 basis `text`，以及「查看全部依據 →」。
    - `hasUser` 時顯示「自訂」Tag。
    - 「ⓘ 依據」按鈕打開 `BasisDrawer`。
    - 「⧉ 引用」按鈕停用，Tooltip 寫「即將推出」。
    - `warnings` 非空時，在答案下方用 `Alert type="warning"` 顯示 `text`。
  - `BasisDrawer`：
    - 列出結果的 `basis`，依 `path` 去除重複。
    - 每項顯示 `text`、值（如果有 `unit` 一併顯示）、狀態 Tag（official、measured、derived、estimate、unverified、user 各用一種 antd 預設色），以及 `lecRef`。
    - `sourceIds` 對應到 `bundle.sources`，顯示來源的 `title` 並連到 `url`（如果有）。
    - 最上方是唯讀的「同時人數的解讀」，依工作類型帶出 `bundle.concurrency` 的說明（spec §8.3.3）。可修改的欄位留到第 4 項。

- [ ] **Step 1: 寫失敗的測試**

```tsx
it('need answer equals core best', () => {
  const b = getBundle(); const r = computeView(b, defaultState(b)) as NeedView;
  render(<App />);
  expect(screen.getByTestId('answer-main')).toHaveTextContent(needAnswerText(r.result, b, tZh).main);
});
it('all NCHC platforms infeasible → plain message, rows still render (Review Focus 1)', () => {
  history.replaceState(null, '', '/?m=mistral-medium-3.5-128b&q=bf16&w=assist&n=100000');
  render(<App />);
  expect(screen.getByTestId('answer-main')).toHaveTextContent('國網機台都不可行');
  expect(screen.getByTestId('answer-sub')).toHaveTextContent('可嘗試較小的模型、較低精度或放寬速度');
});
it('basis drawer lists every basis item with its status', async () => {
  render(<App />); await userEvent.click(screen.getByRole('button', { name: /依據/ }));
  const b = getBundle(); const r = (computeView(b, defaultState(b)) as NeedView).result;
  const paths = new Set(r.basis.map((x) => x.path));
  expect(screen.getAllByTestId('basis-item')).toHaveLength(paths.size);
});
it('estimate tag popover lists the estimates', async () => {
  render(<App />); await userEvent.click(screen.getByText('推估'));
  expect(await screen.findByText('查看全部依據 →')).toBeVisible();
});
it('cite button is present but disabled', () => {
  render(<App />); expect(screen.getByRole('button', { name: /引用/ })).toBeDisabled();
});
```

先執行一次 Review Focus 1 的情境，確認 core 對它回傳 `best = null`。如果不是，就提高人數，直到所有國網平台都不可行，再把那個參數寫進測試。

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pnpm vitest run --project web test/answer.test.tsx`
Expected: FAIL

- [ ] **Step 3: 實作上述 Interfaces**

- [ ] **Step 4: 執行測試，確認通過**

Run: `pnpm vitest run --project web`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web
git commit -m "feat(web): one-line answer with estimate tags and the basis drawer"
```

---

### Task 7: 平台列表、機器圖示與動畫

**Files:**
- Create: `packages/web/src/components/{PlatformList.tsx,PlatformRow.tsx,Isotype.tsx,CapacityBar.tsx}`
- Test: `packages/web/test/platforms.test.tsx`、`packages/web/test/isotype.test.tsx`

**Interfaces:**
- Consumes: `NeedView`、`PlatformResult`、`bundle.platforms`、`transitionMs()`、`Explain`、antd `theme.useToken()`
- Produces:
  ```tsx
  export function PlatformList(): JSX.Element;    // 只在 need 模式顯示
  export function PlatformRow(props: { r: PlatformResult; users: number; best: boolean; open: boolean; onToggle: () => void }): JSX.Element;
  /** 每台機器一個圖示：GPU 平台的台數是 ceil(gpus / gpusPerNode) 個 node，Mac／Spark 是台數。
   *  前 `expected` 個實心，到 `conservative` 為止虛線。gpus 不滿一個 node 時，圖示只填滿相應比例。
   *  數量改變時，用 d3-transition（transitionMs()）長出或縮回，前一個狀態以殘影保留一次轉場。 */
  export function Isotype(props: { expectedGpus: number; conservativeGpus: number | null; gpusPerNode: number; unit: 'gpu' | 'machine' }): JSX.Element;
  export function CapacityBar(props: { users: number; max: number }): JSX.Element;   // 顯示 `同時 {users} / {max} 人`
  ```
  - 平台列的排列：
    - 照 bundle 的平台順序排列。`group === 'self'` 的第一列前面加 `Divider`，文字「自建」。
    - 最佳的那一列加上 3 px 的左側色條（`colorPrimary`），背景用 `colorFillTertiary`。
  - 可行的列由左到右顯示：名稱與 `sub`、`Isotype`、大字台數（下方小字：保守估計較多時顯示 `保守 {n} {張|台}`，否則顯示 `張 GPU` 或 `台`）、`CapacityBar`。
  - 不可行的列只顯示一個 `✗ {短原因}` 的錯誤色 Tag，用 `Explain` 包住，popover 的內容是 core 的 `detail`。
  - 短原因寫在語系檔的 `why.<code>`：
    - `context`：上下文超過模型上限
    - `tp`：無法切分到這台機器
    - `weights`：模型放不下
    - `mem`：記憶體不夠所有人用
    - `bw`：每人速度不夠
    - `compute`：算力不夠
    - `ttft`：首字等太久
  - 可行的列可以點擊或用鍵盤 Enter 展開（`role="button"`、`aria-expanded`），會 dispatch `openRow`。不可行的列不能展開。
  - 窄螢幕（antd 的 `xs` 斷點）隱藏 `Isotype`，其他欄位換行。
  - `CapacityBar` 也用 `Explain` 包住，說明文字：「目前人數 / 這些機器在你要求的速度下最多能同時服務的人數」。

- [ ] **Step 1: 寫失敗的測試**

```tsx
it('one row per platform in bundle order, self group after a divider', () => {
  render(<App />);
  const rows = screen.getAllByTestId('platform-row');
  expect(rows.map((r) => r.dataset.platform)).toEqual(Object.keys(getBundle().platforms));
  expect(screen.getByText('自建')).toBeInTheDocument();
});
it('best row is marked; its big number equals expected.gpus', () => {
  const b = getBundle(); const r = (computeView(b, defaultState(b)) as NeedView).result;
  render(<App />);
  const best = screen.getAllByTestId('platform-row').find((x) => x.dataset.best === 'true')!;
  expect(best.dataset.platform).toBe(r.best);
  const p = r.perPlatform.find((x) => x.platform === r.best)!;
  expect(within(best).getByTestId('count')).toHaveTextContent(String(p.expected.ok && p.expected.gpus));
});
it('infeasible row shows one short reason, detail in a click popover', async () => {
  history.replaceState(null, '', '/?m=mistral-medium-3.5-128b&q=bf16');
  render(<App />);
  const row = screen.getAllByTestId('platform-row').find((x) => x.dataset.platform === 'mac-mini-m6-32')!;
  const tag = within(row).getByText(/^✗ /); await userEvent.click(tag);
  expect(await screen.findByRole('tooltip')).toBeVisible();
  expect(within(row).queryByTestId('capacity')).toBeNull();
});
it('feasible row toggles open by click and Enter', async () => {
  render(<App />); const row = screen.getAllByTestId('platform-row').find((x) => x.dataset.best === 'true')!;
  await userEvent.click(row); expect(row).toHaveAttribute('aria-expanded', 'true');
  row.focus(); await userEvent.keyboard('{Enter}'); expect(row).toHaveAttribute('aria-expanded', 'false');
});
// isotype.test.tsx
it('icons: ceil(gpus / gpusPerNode) solid, extra conservative ones dashed', () => {
  const { container } = render(<Isotype expectedGpus={12} conservativeGpus={20} gpusPerNode={8} unit="gpu" />);
  expect(container.querySelectorAll('[data-icon="solid"]')).toHaveLength(2);
  expect(container.querySelectorAll('[data-icon="dashed"]')).toHaveLength(1);
});
it('reduced motion: final state applied with no transition', () => {
  setMedia({ reducedMotion: true });
  const { container, rerender } = render(<Isotype expectedGpus={8} conservativeGpus={8} gpusPerNode={8} unit="gpu" />);
  rerender(<Isotype expectedGpus={24} conservativeGpus={24} gpusPerNode={8} unit="gpu" />);
  expect(container.querySelectorAll('[data-icon="solid"]')).toHaveLength(3);
});
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pnpm vitest run --project web test/platforms.test.tsx test/isotype.test.tsx`
Expected: FAIL

- [ ] **Step 3: 實作上述 Interfaces**
  - `Isotype` 用 `useRef<SVGSVGElement>` 加 `useEffect` 交給 D3 繪製。資料用 `selection.data(icons, key)` 的 join 處理。
  - 圖示高度固定，同一比例（spec §8.3.1-2）。node 圖示的輪廓用 `<rect>`，Mac 的圖示用圓角較大的 `<rect>`。
  - 顏色取自 `useToken()`：實心用 `colorPrimary`，虛線用 `colorBorder`。

- [ ] **Step 4: 執行測試，確認通過**

Run: `pnpm vitest run --project web`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web
git commit -m "feat(web): per-platform rows with D3 isotype, capacity bar and infeasible reasons"
```

---

### Task 8: 展開的細節：打字示範、使用率條、記憶體組成、功耗

**Files:**
- Create: `packages/web/src/components/{RowDetail.tsx,TypingDemo.tsx,UsageBars.tsx,MemoryBar.tsx}`
- Test: `packages/web/test/detail.test.tsx`、`packages/web/test/typing.test.tsx`

**Interfaces:**
- Consumes: `ShapeUsage`、`PlatformResult.powerKw` 與 `powerNote`、`workload.demoText`、`Explain`
- Produces:
  ```tsx
  export function RowDetail(props: { usage: ShapeUsage; unit: 'gpu' | 'machine'; powerKw: number | null; powerNote?: string; demoText: string }): JSX.Element;
  /** 先等 ttftSec，再以 tokPerSec 個字／秒逐字出現（1 字 = 1 token，計畫者判斷，popover 註明是近似）。
   *  文字放完後停 1.5 秒再重播；reduced motion 時直接顯示全文，並寫出等待秒數與速度。 */
  export function TypingDemo(props: { text: string; tokPerSec: number; ttftSec: number }): JSX.Element;
  export function UsageBars(props: { share: ShapeUsage['share'] }): JSX.Element;
  export function MemoryBar(props: { memory: ShapeUsage['memory'] }): JSX.Element;
  ```
  - `UsageBars`：
    - 四根 antd `Progress`，依序是記憶體、頻寬、算力、首字，`percent = min(100, round(share × 100))`，`status="normal"`。
    - 比例最大的那根，標籤用 `danger` 色並加粗，進度條用 `colorError`。
    - 每根條的 `Explain` 說明（照 v7 草稿）：
      - 記憶體：模型與所有使用者上下文佔用的記憶體
      - 頻寬：每產生一個字要讀取的資料量佔頻寬的比例
      - 算力：讀入與生成所需的計算量佔算力的比例
      - 首字：首字等待時間佔你要求上限的比例
  - `MemoryBar`：
    - 一根橫條，依序是權重、KV（每位常駐使用者一格；超過 60 格時改為連續一段）、保留區、剩餘空間。
    - 用 D3 繪製；人數改變時，KV 格以 `transitionMs()` 長出或縮回（spec §8.3「加人時區塊一格格長出來」）。
    - `Explain` 的內容：`模型 {weights} GB；每人上下文 {perUserKv} GB；保留 {reserve} GB`。GB = bytes / 1e9，保留 1 位小數。
  - 底部小字：
    - GPU 平台寫 `每副本 {tp} 張 GPU × {replicas} 個副本`，Mac 寫 `{replicas} 台`。
    - 功耗：有值時寫 `峰值功耗約 {powerKw} kW`，保留 1 位小數；`powerKw === null` 時寫 `功耗未查證`，並用 `Explain` 包住，內容是 `powerNote`。
    - 如果有 `queueing`，再加一句「尖峰時部分請求需排隊約 {waitSec} 秒，已計入首字時間」，`queueing.reason` 放在 popover。
  - `PlatformRow` 展開時，在列的下方顯示 `RowDetail`，資料是 `r.usage`。

- [ ] **Step 1: 寫失敗的測試**

```tsx
it('largest share is the red bar', () => {
  render(<UsageBars share={{ mem: 0.3, bw: 0.8, compute: 0.1, ttft: 0.5 }} />);
  expect(screen.getByText('頻寬')).toHaveAttribute('data-bottleneck', 'true');
  expect(screen.getByText('記憶體')).not.toHaveAttribute('data-bottleneck');
});
it('bars never auto-turn green at 100%', () => {
  const { container } = render(<UsageBars share={{ mem: 1, bw: 1, compute: 1, ttft: 1 }} />);
  expect(container.querySelector('.ant-progress-status-success')).toBeNull();
});
it('GB200 null TDP → 功耗未查證 with the note (Review Focus 4)', () => {
  const b = getBundle(); const r = (computeView(b, defaultState(b)) as NeedView).result.perPlatform.find((p) => p.platform === 'nano4-gb200')!;
  expect(r.powerKw).toBeNull();
  render(<RowDetail usage={r.usage!} unit="gpu" powerKw={r.powerKw} powerNote={r.powerNote} demoText="x" />);
  expect(screen.getByText('功耗未查證')).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/NaN/);
});
// typing.test.tsx（vi.useFakeTimers）
it('waits ttft, then reveals tokPerSec chars per second', () => {
  render(<TypingDemo text="一二三四五六七八九十" tokPerSec={4} ttftSec={2} />);
  vi.advanceTimersByTime(1900); expect(screen.getByTestId('typed')).toHaveTextContent(/^$/);
  vi.advanceTimersByTime(1100); expect(screen.getByTestId('typed').textContent!.length).toBe(4);
});
it('reduced motion shows the whole text at once', () => {
  setMedia({ reducedMotion: true });
  render(<TypingDemo text="一二三" tokPerSec={4} ttftSec={2} />);
  expect(screen.getByTestId('typed')).toHaveTextContent('一二三');
});
```

先確認預設情境下 core 會讓 GB200 可行，而且 `powerKw` 是 `null`。如果 GB200 在預設情境下不可行，改用一個讓它可行的情境（例如 `?w=chat`），並把參數寫進測試。

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pnpm vitest run --project web test/detail.test.tsx test/typing.test.tsx`
Expected: FAIL

- [ ] **Step 3: 實作上述 Interfaces**

- [ ] **Step 4: 執行測試，確認通過**

Run: `pnpm vitest run --project web`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web
git commit -m "feat(web): expanded row detail with typing demo, usage bars, memory bar and power"
```

---

### Task 9: 「我已有的能撐多少」模式

**Files:**
- Create: `packages/web/src/components/HaveResult.tsx`
- Modify: `App.tsx`
- Test: `packages/web/test/have.test.tsx`

**Interfaces:**
- Consumes: `HaveView`、`CapacityResult`（`expected`、`conservative`、`usage`、`why`、`detail`、`saturated`、`saturatedNote`、`bottleneck`）、`RowDetail`
- Produces: `export function HaveResult(): JSX.Element;`
  - `expected.n > 0` 時：
    - 先顯示小字 `滿載時（同時 {n} 人）`，下方是 `RowDetail`，資料是 `usage`。
    - `bottleneck` 不是 null 時，加一句 `再多 1 人會：{why.<code>}`。
  - `expected.n = 0` 時：顯示 `Alert type="error"`，內容是 `detail`。
  - 數量的單位跟著平台：`unit === 'machine'` 用「台」，否則用「張」。
  - 換平台時保留 `haveCount`。

- [ ] **Step 1: 寫失敗的測試**

```tsx
const go = (q: string) => { history.replaceState(null, '', '/?mode=have&' + q); render(<App />); };
it('answer equals estimateCapacity expected.n', () => {
  const b = getBundle(); go('hp=nano4-h200&have=16');
  const r = computeView(b, decodeUrl(b, location.search)) as HaveView;
  expect(screen.getByTestId('answer-main')).toHaveTextContent(new Intl.NumberFormat('zh-TW').format(r.result.expected.n));
  expect(screen.getByText(/滿載時/)).toBeInTheDocument();
});
it('nobody fits → error alert with core detail', () => {
  go('hp=mac-mini-m6-32&have=1&m=mistral-medium-3.5-128b&q=bf16');
  expect(screen.getByRole('alert')).toBeInTheDocument();
});
it('Mac platform says 台', () => {
  go('hp=mac-studio-m5u-512&have=2');
  expect(screen.getByTestId('sentence')).toHaveTextContent('台');
});
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pnpm vitest run --project web test/have.test.tsx`
Expected: FAIL

- [ ] **Step 3: 實作上述 Interfaces**

- [ ] **Step 4: 執行測試，確認通過**

Run: `pnpm vitest run --project web`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web
git commit -m "feat(web): reverse mode — how many concurrent users existing hardware serves"
```

---

### Task 10: 真實瀏覽器驗證、文件

**Files:**
- Create: `packages/web/playwright.config.ts`、`packages/web/e2e/smoke.spec.ts`
- Modify: 根目錄 `package.json`（`"web:e2e": "pnpm --filter @nchc/web exec playwright test"`）、`README.md`、`.gitignore`（加入 `packages/web/test-results/`、`playwright-report/`）

**Interfaces:**
- Consumes: `pnpm web:build` 的產物、`vite preview`、`needAnswerText` 的規則（e2e 在 Node 端用 core 算出期望值）

- [ ] **Step 1: 安裝 Playwright**
  - 依 Global Constraints 的版本規則，把 `@playwright/test` 加為 web 的 devDependency。
  - 執行 `pnpm --filter @nchc/web exec playwright install chromium`。
  - `playwright.config.ts` 用 `webServer: { command: 'pnpm build && pnpm preview --port 4173', port: 4173 }`。
  - 設兩個 project：桌面 Chrome，以及 `devices['Pixel 7']`（觸控、窄螢幕）。

- [ ] **Step 2: 寫 e2e 測試**（`smoke.spec.ts`）
  - 預設網址：`answer-main` 的文字等於 Node 端以 `estimateRequirements(realBundle(), 預設輸入)` 算出的 `needAnswerText(...).main`。`realBundle()` 的寫法同 core 測試，透過 `loadConfig` 與 `validateConfig`。
  - 依序操作工作、速度、模型三個選單，答案隨之改變，其他兩個選單的顯示值不變。
  - 改人數後，網址的 `n` 跟著改變。用同一個網址重新整理，畫面相同。
  - 展開最佳的那一列，看得到四根使用率條，打字示範在 `ttftSec + 2` 秒內開始出字。
  - 手機 project：點「推估」會出現 popover；打開工作選單時，選項說明直接可見。
  - `page.emulateMedia({ colorScheme: 'dark' })` 後，`body` 的背景色和淺色模式不同。
  - 整個流程的 console 沒有 error。
  - 頁面沒有水平捲動：`document.documentElement.scrollWidth <= innerWidth`。

- [ ] **Step 3: 執行**

Run: `pnpm web:e2e`
Expected: 兩個 project 都 PASS。失敗時附上 Playwright 的 trace 與截圖回報，不要修改斷言。

- [ ] **Step 4: 截圖給使用者看**：桌面淺色、桌面深色、手機各截一張，存到 scratchpad，交付時附上完整路徑。

- [ ] **Step 5: 更新 README**
  - 狀態 badge 改成 `core · web done · MCP pending`。
  - 快速開始加入 `pnpm web:dev`。
  - 改寫「網站與 MCP 尚未開始」那一句：網站已完成主畫面，引用、專家檢視、HF 匯入與自訂輸入尚未開始。
  - 架構圖加入 web 節點。

- [ ] **Step 6: 全部驗證**

Run: `pnpm test && pnpm typecheck && pnpm web:build && pnpm web:e2e`
Expected: 全部 PASS。

- [ ] **Step 7: Commit**

```bash
git add packages/web package.json pnpm-lock.yaml README.md .gitignore
git commit -m "test(web): Playwright smoke on desktop and mobile; document the website"
```
