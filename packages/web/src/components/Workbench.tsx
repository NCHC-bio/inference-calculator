import { CodeOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { PerformanceResult, Queueing } from '@nchc/core';
import { Button, Collapse, Flex, Typography } from 'antd';
import { useRef, useState, type JSX, type ReactNode } from 'react';
import { getBundle } from '../bundle';
import { speedTarget } from '../compute/actions';
import type { BenchView, OkRow } from '../compute/compute';
import { useBench, useDeferredState } from '../compute/useResults';
import { unitWord, useLang, useT } from '../i18n';
import type { Lang } from '../i18n/t';
import { useTween } from '../motion/useTween';
import { workloadId, type Action, type CalcState } from '../state/state';
import { useCalc } from '../state/store';
import { ActionChips } from './ActionChips';
import { Explain } from './Explain';
import { MemoryBar } from './MemoryBar';
import { rowInfo } from './PlatformRow';
import { Roofline } from './Roofline';
import { SpeedChart, speedZones, type ChartZone } from './SpeedChart';
import { SplitSelect, SplitText, splitText } from './SplitSelect';
import { TypingDemo } from './TypingDemo';
import { UsageBars } from './UsageBars';
import { WHY } from './why';

const fmtIn = (lang: string, n: number, d = 0) => new Intl.NumberFormat(lang, { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
const small = { fontSize: 12 } as const;

/** A number that tweens to `v` (design §3.6: numbers tween). */
function TNum({ v, d = 0, testId }: { v: number; d?: number; testId?: string }): JSX.Element {
  const lang = useLang();
  const x = useTween(v);
  return <b data-testid={testId}>{fmtIn(lang, x, d)}</b>;
}

/** Renders a translated sentence with `children` in place of its `{v}` (keeps the tweened number inside one sentence). */
function Slot({ text, children }: { text: string; children: ReactNode }): JSX.Element {
  const [before, after] = text.split('{v}');
  return (
    <>
      {before}
      {children}
      {after}
    </>
  );
}

function Heading({ children }: { children: ReactNode }): JSX.Element {
  return <div className="wb-h">{children}</div>;
}

/**
 * 「模型（量化）」 (en 「model (quant)」), without the suffix when the name already carries the quant as a token (display
 * only).
 */
export function withQuant(name: string, quant: string, lang: Lang = 'zh-TW'): string {
  const esc = quant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`, 'i').test(name)) return name;
  return lang === 'en' ? `${name} (${quant})` : `${name}（${quant}）`;
}

/** Peak power, or 「功耗未查證」 with core's note (plus the bundle TDP record's reason) on hover. */
function PowerLine({ perf, tdpConflict }: { perf: PerformanceResult; tdpConflict: string | null }): JSX.Element {
  const tr = useT();
  const kw = useTween(perf.powerKw ?? 0);
  const lang = useLang();
  const style = { ...small, display: 'block', marginTop: 8 } as const;
  if (perf.powerKw !== null) {
    return (
      <Typography.Text type="secondary" style={style}>
        <ThunderboltOutlined /> {tr('detail.power', { kw: fmtIn(lang, kw, 1) })}
      </Typography.Text>
    );
  }
  const note = perf.powerNote === undefined ? undefined : tdpConflict ? tr('detail.powerNote', { note: perf.powerNote, why: tdpConflict }) : perf.powerNote;
  return (
    <Typography.Text type="secondary" style={style}>
      <ThunderboltOutlined />{' '}
      {note ? (
        <Explain content={<div style={{ maxWidth: 300 }}>{note}</div>}>
          <span tabIndex={0} className="help-text">
            {tr('detail.powerUnknown')}
          </span>
        </Explain>
      ) : (
        tr('detail.powerUnknown')
      )}
    </Typography.Text>
  );
}

/** At peak some requests queue: one sentence with core's wait, its reason on hover / tap / focus; nothing without queueing. */
export function QueueLine({ queueing }: { queueing: Queueing | null }): JSX.Element | null {
  const tr = useT();
  const lang = useLang();
  if (!queueing) return null;
  return (
    <Typography.Text type="secondary" data-testid="queue-line" style={{ ...small, display: 'block', marginTop: 4 }}>
      <Explain content={<div style={{ maxWidth: 320 }}>{queueing.reason}</div>}>
        <span tabIndex={0} className="help-text">
          {tr('detail.queue', { sec: fmtIn(lang, queueing.waitSec, 1) })}
        </span>
      </Explain>
    </Typography.Text>
  );
}

type ChartCtx = { row: OkRow; bench: BenchView; s: CalcState; unit: 'gpu' | 'machine'; unitOf: (n: number) => string; zones: ChartZone[]; target: { y: number; label: string } | null };

/**
 * 「卡數 → 每人速度」 over core's sweep. Ruling W9: each count plots its fastest split that serves the users on target
 * (`fastest`, solid); without one, the default split's numbers as a miss (dashed). A click sets the count with the plotted
 * split (tp only when it differs from the default); the suggested count with the recommended split clears the override.
 */
function CardsChart({ row, bench, s, unit, unitOf, zones, target, dispatch }: ChartCtx & { dispatch: (a: Action) => void }): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const usage = bench.perf.usage!;
  const at = (x: number) => bench.sweep.find((q) => q.gpus === x);
  const note = (x: number) => {
    const p = at(x);
    const n = fmtIn(lang, x);
    if (p?.fastest) {
      const f = p.fastest;
      return tr('chart.note.cards', { n, unit: unitOf(x), split: splitText(f.shape.tp, f.shape.replicas, unit, tr), tps: fmtIn(lang, f.tokPerSecPerUser) });
    }
    if (!p || !p.shape || p.tokPerSecPerUser === null) return tr('chart.note.noFit', { n, unit: unitOf(x) });
    const why = p.why ? tr('chart.note.why', { why: tr(WHY[p.why]) }) : '';
    return tr('chart.note.cards', { n, unit: unitOf(x), split: splitText(p.shape.tp, p.shape.replicas, unit, tr), tps: fmtIn(lang, p.tokPerSecPerUser) }) + why;
  };
  const pick = (gpus: number) => {
    const p = at(gpus);
    const tp = p?.fastest && p.shape && p.fastest.shape.tp !== p.shape.tp ? p.fastest.shape.tp : undefined;
    if (tp !== undefined) dispatch({ type: 'override', row: row.row, value: { gpus, tp } });
    else dispatch({ type: 'override', row: row.row, value: gpus === row.suggested ? null : { gpus } });
  };
  const xs = bench.sweep.map((p) => p.gpus);
  const label = tr('chart.aria.cards', {
    title: tr(unit === 'machine' ? 'wb.chart.cards.machine' : 'wb.chart.cards.gpu'),
    lo: fmtIn(lang, Math.min(...xs)),
    hi: fmtIn(lang, Math.max(...xs)),
    unit: unitOf(Math.max(...xs)),
    n: fmtIn(lang, row.count),
    nUnit: unitOf(row.count),
    tps: fmtIn(lang, usage.tokPerSecPerUser),
    s: fmtIn(lang, row.suggested),
    sUnit: unitOf(row.suggested),
  });
  return (
    <SpeedChart
      label={label}
      points={bench.sweep.map((p) => (p.fastest ? { x: p.gpus, y: p.fastest.tokPerSecPerUser } : { x: p.gpus, y: p.tokPerSecPerUser, miss: true }))}
      xTitle={tr(unit === 'machine' ? 'chart.x.cards.machine' : 'chart.x.cards.gpu', { users: fmtIn(lang, s.users) })}
      yTitle={tr('chart.y')}
      zones={zones}
      target={target}
      marks={[
        { key: 'suggested', x: row.suggested, label: tr('chart.mark.suggested'), tone: 'muted', dashed: true },
        { key: 'current', x: row.count, y: usage.tokPerSecPerUser, label: tr('chart.mark.current'), tone: 'primary' },
      ]}
      onPick={pick}
      pointNote={note}
    />
  );
}

/** 「人數 → 每人速度」 over core's speedCurve (1 … max(maxConcurrent, users)); points past the limit carry `why` (dashed). */
function UsersChart({ row, bench, s, unitOf, zones, target }: ChartCtx): JSX.Element | null {
  const tr = useT();
  const lang = useLang();
  const { perf, userCurve } = bench;
  if (!userCurve) return null;
  const note = (x: number) => {
    const p = userCurve.points.find((q) => q.users === x);
    if (!p) return '';
    const why = p.why ? tr('chart.note.why', { why: tr(WHY[p.why]) }) : '';
    return tr('chart.note.users', { n: fmtIn(lang, x), tps: fmtIn(lang, p.tokPerSecPerUser), ttft: fmtIn(lang, p.ttftSec, 1) }) + why;
  };
  const us = userCurve.points.map((p) => p.users);
  const label = tr('chart.aria.users', {
    title: tr('wb.chart.users'),
    lo: fmtIn(lang, Math.min(...us)),
    hi: fmtIn(lang, Math.max(...us)),
    users: fmtIn(lang, s.users),
    tps: fmtIn(lang, perf.usage!.tokPerSecPerUser),
    max: fmtIn(lang, perf.maxConcurrent),
  });
  return (
    <SpeedChart
      label={label}
      points={userCurve.points.map((p) => ({ x: p.users, y: p.tokPerSecPerUser, miss: p.why !== null }))}
      xTitle={tr('chart.x.users', { n: fmtIn(lang, row.count), unit: unitOf(row.count) })}
      yTitle={tr('chart.y')}
      zones={zones}
      target={target}
      marks={[
        { key: 'current', x: s.users, y: perf.usage!.tokPerSecPerUser, label: tr('chart.mark.current'), tone: 'primary' },
        ...(perf.maxConcurrent > 0 ? [{ key: 'max', x: perf.maxConcurrent, label: tr('chart.mark.max'), tone: 'error' as const, dashed: true }] : []),
      ]}
      pointNote={note}
    />
  );
}

/** Footer:「更多圖表（Roofline，專家用）」 Collapse (left) and 「驗證指令」 (right, in the item's `extra`, never toggles it). */
function Foot({ onVerify, roofline }: { onVerify: () => void; roofline: ReactNode }): JSX.Element {
  const tr = useT();
  const [open, setOpen] = useState<string[]>([]);
  return (
    <div className="wb-foot">
      <Collapse
        ghost
        size="small"
        activeKey={open}
        onChange={(k) => setOpen(k)}
        items={[
          {
            key: 'roofline',
            collapsible: 'header',
            label: (
              <Typography.Text type="secondary" style={small}>
                {tr('wb.more')}
              </Typography.Text>
            ),
            extra: (
              <Button
                type="link"
                size="small"
                style={{ padding: 0, height: 'auto' }}
                icon={<CodeOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  onVerify();
                }}
              >
                {tr('wb.verify')}
              </Button>
            ),
            children: (
              <div data-testid="chart-roofline" className="wb-chart">
                {roofline}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

type Props = { row: OkRow; bench: BenchView; s: CalcState; dispatch: (a: Action) => void };

/** The workbench body for a bench that has usage (the split fits and serves at least one user). */
function Body({ row, bench, s, dispatch }: Props): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const b = getBundle();
  const { perf } = bench;
  const usage = perf.usage!;
  const shape = perf.shape ?? usage.shape;
  const info = rowInfo(b, s, row.row);
  const unitOf = (n: number) => unitWord(tr, info.unit, fmtIn(lang, n));
  const target = speedTarget(b, s);
  const demoText = b.workloads[workloadId(s.workload)]!.demoText;
  const tdp = info.hardware === null ? undefined : b.hardware[info.hardware]?.tdpW;
  const tdpConflict = tdp?.value === null && tdp.conflict ? tdp.conflict : null;
  const zones = speedZones(b, tr);
  // A custom speed target that is not a zone boundary gets its own line.
  const chartTarget = typeof s.speed !== 'string' && !zones.some((z) => z.lo === target.min) ? { y: target.min, label: `${tr('chart.mark.target')} ${fmtIn(lang, target.min)}` } : null;
  const chart: ChartCtx = { row, bench, s, unit: info.unit, unitOf, zones, target: chartTarget };

  const pickSplit = (tp: number) => {
    if (tp === perf.recommendedTp) {
      dispatch({ type: 'override', row: row.row, value: row.count === row.suggested ? null : { gpus: row.count } });
    } else dispatch({ type: 'override', row: row.row, value: { gpus: row.count, tp } });
  };

  return (
    <div className="wb" data-testid="workbench">
      <div className="wb-top">
        <Typography.Text type="secondary" style={small}>
          {tr('wb.summary', { n: fmtIn(lang, row.count), unit: unitOf(row.count), name: info.name, users: fmtIn(lang, s.users) })}
          <SplitText tp={shape.tp} replicas={shape.replicas} unit={info.unit} />
        </Typography.Text>
      </div>

      <div className="wb-row-1">
        <section data-area="exp">
          <Heading>{tr('wb.exp')}</Heading>
          <TypingDemo text={demoText} tokPerSec={usage.tokPerSecPerUser} ttftSec={usage.ttftSec} reset={row.row} />
          <Flex gap={16} wrap="wrap" style={{ marginTop: 10 }}>
            <span>
              <Slot text={tr('wb.tps')}>
                <TNum v={usage.tokPerSecPerUser} testId="metric-tps" />
              </Slot>
              <Typography.Text type="secondary">{tr('wb.tps.target', { v: fmtIn(lang, target.min) })}</Typography.Text>
            </span>
            <span>
              <Slot text={tr('wb.ttft')}>
                <TNum v={usage.ttftSec} d={1} testId="metric-ttft" />
              </Slot>
              <Typography.Text type="secondary">{tr('wb.ttft.limit', { v: new Intl.NumberFormat(lang).format(target.ttft) })}</Typography.Text>
            </span>
            <span>
              <Slot text={tr('wb.max')}>
                <TNum v={perf.maxConcurrent} testId="metric-max" />
              </Slot>
            </span>
          </Flex>
          <ActionChips actions={bench.actions} ok={perf.ok} onApply={(a) => a.apply.forEach(dispatch)} />
        </section>
        <section data-area="why">
          <Heading>{tr('wb.why')}</Heading>
          <UsageBars share={usage.share} />
          <div style={{ marginTop: 10 }}>
            <Typography.Text type="secondary" style={small}>
              {tr('wb.memory')}
            </Typography.Text>
            <MemoryBar memory={usage.memory} />
          </div>
          <SplitSelect perf={perf} unit={info.unit} onPick={pickSplit} />
          <PowerLine perf={perf} tdpConflict={tdpConflict} />
          <QueueLine queueing={perf.queueing} />
        </section>
      </div>

      <div className="wb-row-2">
        <section data-area="cards">
          <Heading>
            {tr(info.unit === 'machine' ? 'wb.chart.cards.machine' : 'wb.chart.cards.gpu')}{' '}
            <Typography.Text type="secondary" style={{ ...small, fontWeight: 400 }}>
              {tr(info.unit === 'machine' ? 'wb.chart.cards.hint.machine' : 'wb.chart.cards.hint.gpu')}
            </Typography.Text>
          </Heading>
          <div data-testid="chart-cards" className="wb-chart">
            <CardsChart {...chart} dispatch={dispatch} />
          </div>
        </section>
        <section data-area="users">
          <Heading>
            {tr('wb.chart.users')}{' '}
            <Typography.Text type="secondary" style={{ ...small, fontWeight: 400 }}>
              {tr('wb.chart.users.hint', { n: fmtIn(lang, row.count), unit: unitOf(row.count) })}
            </Typography.Text>
          </Heading>
          <div data-testid="chart-users" className="wb-chart">
            <UsersChart {...chart} />
          </div>
        </section>
      </div>

      <Foot onVerify={() => dispatch({ type: 'dialog', id: 'verify' })} roofline={<Roofline roofline={usage.roofline} unit={info.unit} />} />
    </div>
  );
}

/**
 * 試算區（design §4 item 5, demo v8 `Workbench`）: one view, no tabs. Top line (count, users, split in plain words); row 1 體驗 | 原因; row 2 the two charts; footer 更多圖表 + 驗證指令. When the split does not fit or serves
 * nobody (no usage): only the reason and the suggested actions.
 *
 * Bench data is computed only while this row is open; a closed row keeps its last bench so the close animation still
 * has content; the list's Collapse (`destroyOnHidden`) unmounts it once that animation ends.
 */
export function Workbench({ row }: { row: OkRow }): JSX.Element | null {
  const tr = useT();
  const [, dispatch] = useCalc();
  const s = useDeferredState();
  const fresh = useBench(s.openRow === row.row ? row.row : null);
  const last = useRef<BenchView | null>(null);
  if (fresh) last.current = fresh;
  const bench = fresh ?? last.current;
  if (!bench) return null;
  const { perf } = bench;
  if (!perf.usage) {
    return (
      <div className="wb fade-in" data-testid="workbench">
        <div>
          {perf.why && (
            <Typography.Text type="danger" strong style={{ display: 'block' }}>
              {tr(WHY[perf.why])}
            </Typography.Text>
          )}
          {perf.detail && <Typography.Text type="secondary">{perf.detail}</Typography.Text>}
        </div>
        <ActionChips actions={bench.actions} ok={perf.ok} onApply={(a) => a.apply.forEach(dispatch)} />
      </div>
    );
  }
  return <Body row={row} bench={bench} s={s} dispatch={dispatch} />;
}
