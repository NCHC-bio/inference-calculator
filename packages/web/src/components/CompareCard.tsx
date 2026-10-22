import { CheckCircleOutlined, CloseCircleOutlined, DeleteOutlined, DownOutlined, LineChartOutlined, SwapOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Dropdown, Flex, Space, Table, Tag, Tooltip, Typography, type MenuProps } from 'antd';
import { useRef, useState, type HTMLAttributes, type JSX, type ReactNode } from 'react';
import { getBundle } from '../bundle';
import { speedTarget } from '../compute/actions';
import { variantGroups, type CompareView, type LineView, type VariantGroup, type VariantLabel } from '../compute/compare';
import { useCompare, useDeferredState, useMain } from '../compute/useResults';
import { unitWord, useLang, useT } from '../i18n';
import type { MsgKey, TFn } from '../i18n/t';
import { useWidth } from '../media';
import { useDarkMode } from '../theme';
import { useTween } from '../motion/useTween';
import { COMPARE_MAX, type CompareSpec } from '../state/state';
import { useCalc } from '../state/store';
import { STATUS_COLOR } from './BasisModal';
import { CompareChart, LETTERS, SERIES, valueAt, type CompareSeries } from './CompareChart';
import { Explain } from './Explain';
import { subLabelText } from './PlatformRow';
import { WHY } from './why';

/** Below this card width the summary is one card per line instead of a table (design v9 §4.2; the table needs ~880 px). */
const NARROW = 880;
const small = { fontSize: 12 } as const;
const nowrap = { whiteSpace: 'nowrap' } as const;

const fmtIn = (lang: string, n: number, d = 0) => new Intl.NumberFormat(lang, { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);

/** A number that tweens to `v`, formatted into `key`'s `{v}`. */
function TNum({ k, v, d = 0 }: { k: MsgKey; v: number; d?: number }): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const x = useTween(v);
  return <span style={nowrap}>{tr(k, { v: fmtIn(lang, x, d) })}</span>;
}

const sizeText = (tr: TFn, lang: string, totalB: number, activeB: number | null) =>
  activeB === null ? tr('compare.size', { total: fmtIn(lang, totalB) }) : tr('compare.sizeMoe', { total: fmtIn(lang, totalB), active: fmtIn(lang, activeB, 1) });

/** Line sample (colour, dashed for estimates) and letter. */
function Swatch({ v, color, dashed }: { v: LineView; color: string; dashed: boolean }): JSX.Element {
  return (
    <span style={{ flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
      <svg width="22" height="10" aria-hidden="true">
        <line x1="1" y1="5" x2="21" y2="5" stroke={color} strokeWidth="3" strokeLinecap="round" strokeDasharray={dashed ? '5 3' : undefined} />
      </svg>
      <b>{LETTERS[v.line.slot]}</b>
    </span>
  );
}

/** First line: platform × count; second: model・precision (・task・read length); overridden fields in bold. */
function LineName({ v, color, dashed }: { v: LineView; color: string; dashed: boolean }): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const B = (on: boolean, text: string) => (on ? <b>{text}</b> : text);
  const count = `${fmtIn(lang, v.count)} ${unitWord(tr, v.info.unit, fmtIn(lang, v.count))}`;
  return (
    <Flex gap={8} align="start" style={{ minWidth: 0 }}>
      <Swatch v={v} color={color} dashed={dashed} />
      <div style={{ minWidth: 0 }}>
        <div style={{ overflowWrap: 'anywhere' }}>
          {v.info.name} {subLabelText(v.info.sub, lang, tr)} × {B(v.changed.gpus, count)}
          {v.perf?.hasEstimate && (
            <Tag color={STATUS_COLOR.estimate} style={{ borderStyle: 'dashed', marginInlineStart: 6 }}>
              {tr('tag.estimate')}
            </Tag>
          )}
          {v.perf?.hasUser && (
            <Tag color={STATUS_COLOR.user} style={{ marginInlineStart: 6 }}>
              {tr('tag.user')}
            </Tag>
          )}
        </div>
        <Typography.Text type="secondary" style={{ ...small, overflowWrap: 'anywhere' }}>
          {B(v.changed.model, v.modelName)}・{B(v.changed.quant, v.quantName)}
          {v.changed.workload && <>・{B(true, v.workloadName)}</>}
          {v.changed.inputTokens && <>・{B(true, tr('compare.read', { n: readText(lang, v.inputTokens) }))}</>}
        </Typography.Text>
      </div>
    </Flex>
  );
}

const readText = (lang: string, n: number) => (n % 1000 === 0 ? `${fmtIn(lang, n / 1000)}k` : fmtIn(lang, n));

/** 達標 / 不達標：原因 / 放不下, core's detail on hover / tap / focus. */
function Verdict({ v }: { v: LineView }): JSX.Element {
  const tr = useT();
  const lang = useLang();
  if (v.status === 'ok') {
    return (
      <Tag color="success" icon={<CheckCircleOutlined />} style={{ marginInlineEnd: 0 }}>
        {tr('compare.ok')}
      </Tag>
    );
  }
  const why = v.perf?.why ? tr(WHY[v.perf.why]) : '';
  const detail =
    v.error ??
    v.perf?.detail ??
    (v.perf && v.perf.maxConcurrent > 0 ? tr('compare.failTip', { why, n: fmtIn(lang, v.perf.maxConcurrent) }) : tr('compare.failTipNone', { why }));
  const tag =
    v.status === 'nofit' ? (
      <Tag color="default" icon={<CloseCircleOutlined />} tabIndex={0} style={{ marginInlineEnd: 0, cursor: 'help' }}>
        {tr('compare.nofit')}
      </Tag>
    ) : (
      <Tag color="error" icon={<CloseCircleOutlined />} tabIndex={0} style={{ marginInlineEnd: 0, cursor: 'help', whiteSpace: 'normal', maxWidth: 140 }}>
        {tr('compare.fail', { why })}
      </Tag>
    );
  return <Explain content={<div style={{ maxWidth: 300 }}>{detail}</div>}>{tag}</Explain>;
}

/** Label of one 「換一項比較」 item. */
function variantText(l: VariantLabel, tr: TFn, lang: string): string {
  const b = getBundle();
  switch (l.kind) {
    case 'model':
      return `${l.name}・${sizeText(tr, lang, l.totalB, l.activeB)}`;
    case 'quant':
      return l.all ? tr('compare.variant.quantAll') : (b.quantization[l.id]?.name ?? l.id);
    case 'workload':
      return b.workloads[l.id]?.name ?? l.id;
    case 'read':
      return tr('compare.variant.readItem', { n: readText(lang, l.tokens) });
    case 'gpus':
      return '';
    case 'platform':
      return '';
  }
}

const GROUP_KEY: Record<VariantGroup['key'], MsgKey> = {
  model: 'compare.variant.model',
  quant: 'compare.variant.quant',
  workload: 'compare.variant.workload',
  read: 'compare.variant.read',
  gpus: 'compare.variant.gpus',
  platform: 'compare.variant.platform',
};

type CardCtx = {
  view: CompareView;
  color: (v: LineView) => string;
  dashed: (v: LineView) => boolean;
  actions: (v: LineView) => ReactNode;
};

/**
 * Dashes mark the lines that use estimated inputs only when they tell lines apart: when every line does (most of the
 * catalog today), all are solid and the note says so; each line still carries its 推估 tag (spec §2.1).
 */
export function dashedOf(view: CompareView): { dashed: (v: LineView) => boolean; allEst: boolean } {
  const withPerf = view.lines.filter((v) => v.perf);
  const allEst = withPerf.length > 0 && withPerf.every((v) => v.perf!.hasEstimate);
  return { allEst, dashed: (v) => !allEst && (v.perf?.hasEstimate ?? false) };
}

const Dash = () => <Typography.Text type="secondary">—</Typography.Text>;

/** One metric cell; nothing to show for a line that does not fit. */
function metric(v: LineView, k: 'tps' | 'ttft' | 'max' | 'kw' | 'size', tr: TFn, lang: string): ReactNode {
  const p = v.perf;
  if (k === 'size') {
    return (
      <Explain content={<div style={{ maxWidth: 280 }}>{tr('compare.sizeTip')}</div>}>
        <span tabIndex={0} className="help-text cmp-size">
          {sizeText(tr, lang, v.params.totalB, v.params.activeB)}
        </span>
      </Explain>
    );
  }
  if (!p || v.status === 'nofit') return <Dash />;
  if (k === 'tps') return <TNum k="compare.tps" v={p.usage!.tokPerSecPerUser} />;
  if (k === 'ttft') return <TNum k="compare.ttft" v={p.usage!.ttftSec} d={1} />;
  if (k === 'max') {
    if (!p.ok && p.maxConcurrent === 0) {
      return (
        <Typography.Text type="danger" style={nowrap}>
          {tr('compare.unreachable')}
        </Typography.Text>
      );
    }
    return <TNum k="compare.max" v={p.maxConcurrent} />;
  }
  if (p.powerKw !== null) return <TNum k="compare.kw" v={p.powerKw} d={1} />;
  const unknown = (
    <Typography.Text type="secondary" style={nowrap}>
      {tr('status.unverified')}
    </Typography.Text>
  );
  return p.powerNote ? (
    <Explain content={<div style={{ maxWidth: 300 }}>{p.powerNote}</div>}>
      <span tabIndex={0} className="help-text">
        {unknown}
      </span>
    </Explain>
  ) : (
    unknown
  );
}

const METRICS = [
  { k: 'tps', title: 'compare.col.tps', align: 'right' },
  { k: 'ttft', title: 'compare.col.ttft', align: 'right' },
  { k: 'max', title: 'compare.col.max', align: 'right' },
  { k: 'size', title: 'compare.col.size', align: 'left' },
  { k: 'kw', title: 'compare.col.kw', align: 'right' },
] as const;

function Summary({ view, color, dashed, actions, narrow }: CardCtx & { narrow: boolean }): JSX.Element {
  const tr = useT();
  const lang = useLang();
  if (narrow) {
    return (
      <div>
        {view.lines.map((v) => (
          <div
            key={v.line.id}
            data-testid="compare-line"
            className="fade-in cmp-line-card"
            style={{ borderInlineStart: `4px solid ${color(v)}` }}
          >
            <LineName v={v} color={color(v)} dashed={dashed(v)} />
            <div style={{ margin: '6px 0' }}>
              <Verdict v={v} />
            </div>
            <Flex gap={14} wrap="wrap" style={{ fontSize: 13 }}>
              {METRICS.map((m) => (
                <span key={m.k}>
                  <Typography.Text type="secondary" style={small}>
                    {tr(m.title)}{' '}
                  </Typography.Text>
                  {metric(v, m.k, tr, lang)}
                </span>
              ))}
            </Flex>
            <div style={{ marginTop: 6 }}>{actions(v)}</div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <Table<LineView>
      size="small"
      pagination={false}
      scroll={{ x: 'max-content' }}
      rowKey={(v) => v.line.id}
      dataSource={view.lines}
      onRow={() => ({ 'data-testid': 'compare-line' }) as HTMLAttributes<HTMLElement>}
      columns={[
        {
          title: tr('compare.col.plan'),
          key: 'plan',
          // Actions sit under the name (as on the narrow cards), so the table fits the card at every width.
          render: (_, v) => (
            <div style={{ minWidth: 200, maxWidth: 280 }}>
              <LineName v={v} color={color(v)} dashed={dashed(v)} />
              <div style={{ marginTop: 4, paddingInlineStart: 38 }}>{actions(v)}</div>
            </div>
          ),
        },
        // Headers may wrap (English ones are long); the values stay on one line.
        { title: tr('compare.col.verdict'), key: 'verdict', render: (_, v) => <Verdict v={v} /> },
        ...METRICS.map((m) => ({
          title: tr(m.title),
          key: m.k,
          align: m.align,
          render: (_: unknown, v: LineView) => metric(v, m.k, tr, lang),
        })),
      ]}
    />
  );
}

/**
 * 方案比較（design v9 §4, demo v9 `CompareCard`）: one line per setup, live with the sentence. Summary (table, or one card
 * per line below NARROW px), then the users → speed and users → first word charts side by side (stacked when narrow)
 * sharing one crosshair, and the GPUs → speed chart when the lines use different GPU setups. The card grows open with
 * the first line and keeps its last view while closing.
 */
export function CompareCard({ width }: { width?: number } = {}): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const dark = useDarkMode();
  const [current, dispatch] = useCalc();
  const s = useDeferredState();
  const main = useMain();
  const fresh = useCompare();
  const last = useRef<CompareView | null>(null);
  if (fresh) last.current = fresh;
  const view = fresh ?? last.current;
  const [wrap, measured] = useWidth<HTMLDivElement>();
  const w = width ?? measured;
  const narrow = w > 0 && w < NARROW;
  const [hoverUsers, setHoverUsers] = useState<number | null>(null);
  const [hoverCards, setHoverCards] = useState<number | null>(null);
  const { message } = AntApp.useApp();
  const open = current.compare.length > 0;
  const palette = SERIES[dark ? 'dark' : 'light'];
  const color = (v: LineView) => palette[v.line.slot] ?? palette[0];
  const full = current.compare.length >= COMPARE_MAX;
  const target = speedTarget(getBundle(), s);

  const add = (specs: CompareSpec[]) => {
    const free = COMPARE_MAX - current.compare.length;
    if (free <= 0) {
      void message.warning(tr('compare.full', { n: COMPARE_MAX }));
      return;
    }
    if (specs.length > free) void message.warning(tr('compare.partial', { n: COMPARE_MAX, k: free }));
    dispatch({ type: 'compareAdd', lines: specs });
  };

  const menuOf = (v: LineView): MenuProps['items'] =>
    variantGroups(getBundle(), s, main, v).map((g) => ({
      key: g.key,
      label: tr(GROUP_KEY[g.key]),
      children: g.items.map((it) => {
        const l = it.label;
        let label = variantText(l, tr, lang);
        if (l.kind === 'gpus') {
          label = `${fmtIn(lang, l.n)} ${unitWord(tr, v.info.unit, fmtIn(lang, l.n))}${l.half ? tr('compare.variant.half') : ''}`;
        }
        if (l.kind === 'platform') {
          const line = view?.lines.find((x) => x.line.row === l.row);
          const info = line?.info;
          const name = info ? `${info.name} ${subLabelText(info.sub, lang, tr)}` : l.row;
          label = `${name}（${fmtIn(lang, l.count)}）`;
        }
        return { key: it.key, label, ...(l.kind === 'quant' && l.all ? { style: { borderTop: '1px solid rgba(128,128,128,.2)' } } : {}) };
      }),
    }));

  const actions = (v: LineView) => {
    const groups = () => variantGroups(getBundle(), s, main, v);
    const button = (
      <Dropdown
        trigger={['click']}
        disabled={full}
        menu={{
          items: menuOf(v),
          triggerSubMenuAction: 'click',
          onClick: ({ key }) => {
            const item = groups()
              .flatMap((g) => g.items)
              .find((i) => i.key === key);
            if (item) add(item.specs);
          },
        }}
      >
        <Button size="small" icon={<SwapOutlined />} disabled={full}>
          {tr('compare.variant')} <DownOutlined />
        </Button>
      </Dropdown>
    );
    return (
      <Space size={4}>
        {full ? (
          <Tooltip title={tr('compare.full', { n: COMPARE_MAX })}>
            <span>{button}</span>
          </Tooltip>
        ) : (
          button
        )}
        <Button size="small" type="text" aria-label={tr('compare.delete')} icon={<DeleteOutlined />} onClick={() => dispatch({ type: 'compareRemove', id: v.line.id })} />
      </Space>
    );
  };

  const dash = view ? dashedOf(view) : { allEst: false, dashed: () => false };
  const charts = view && <Charts view={view} dashed={dash.dashed} users={s.users} target={target} hoverUsers={hoverUsers} setHoverUsers={setHoverUsers} hoverCards={hoverCards} setHoverCards={setHoverCards} />;

  return (
    <div className={'reveal' + (open ? ' on' : '')} inert={!open} aria-hidden={!open}>
      <div>
        <Card
          data-testid="compare"
          size="small"
          style={{ marginTop: 12 }}
          title={
            <span>
              <LineChartOutlined /> {tr('compare.title')}
            </span>
          }
          extra={
            <Button type="link" size="small" onClick={() => dispatch({ type: 'compareClear' })}>
              {tr('compare.clear')}
            </Button>
          }
        >
          <div ref={wrap} style={{ minWidth: 0 }}>
            {view && (
              <>
                <Typography.Text type="secondary" style={{ ...small, display: 'block', marginBottom: 8 }}>
                  {tr('compare.note', { users: fmtIn(lang, s.users), tps: fmtIn(lang, target.min), ttft: fmtIn(lang, target.ttft) })}
                  {tr(dash.allEst ? 'compare.note.allEst' : 'compare.note.dashed')}
                </Typography.Text>
                <Summary view={view} color={color} dashed={dash.dashed} actions={actions} narrow={narrow} />
                <Typography.Text type="secondary" style={{ ...small, display: 'block', marginTop: 6 }}>
                  {tr('compare.hint')}
                </Typography.Text>
                {charts}
                {view.warnings.map((x) => (
                  <Alert key={x.code} type="warning" showIcon title={x.text} style={{ marginTop: 8 }} />
                ))}
              </>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

type ChartsProps = {
  view: CompareView;
  dashed: (v: LineView) => boolean;
  users: number;
  target: { min: number; ttft: number };
  hoverUsers: number | null;
  setHoverUsers: (x: number | null) => void;
  hoverCards: number | null;
  setHoverCards: (x: number | null) => void;
};

/** The two users charts (shared crosshair) and the GPUs chart, with the notes for lines that are not drawn. */
function Charts({ view, dashed, users, target, hoverUsers, setHoverUsers, hoverCards, setHoverCards }: ChartsProps): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const f = (n: number, d = 0) => fmtIn(lang, n, d);
  const drawn = view.lines.filter((v) => v.users.length > 0);
  const usersSeries = (key: 'tps' | 'ttft'): CompareSeries[] =>
    drawn.map((v) => {
      const points = v.users.map((p) => ({ x: p.x, y: p[key] }));
      const at = v.users.find((p) => p.x === users);
      const mc = v.perf?.maxConcurrent ?? 0;
      const capY = mc > 0 ? valueAt(points, mc) : null;
      return {
        key: String(v.line.id),
        slot: v.line.slot,
        dashed: dashed(v),
        points,
        ...(at ? { dot: { x: users, y: at[key] } } : {}),
        ...(key === 'tps' && capY !== null ? { cap: { x: mc, y: capY, label: tr('compare.cap', { n: f(mc) }) } } : {}),
      };
    });
  const cards: CompareSeries[] = view.lines
    .filter((v) => v.sweep && v.sweep.length > 0)
    .map((v) => {
      const points = v.sweep!.map((p) => ({ x: p.x, y: p.tps }));
      const at = points.find((p) => p.x === v.count);
      return { key: String(v.line.id), slot: v.line.slot, dashed: dashed(v), points, ...(at ? { dot: at } : {}) };
    });
  const letters = (ls: LineView[]) => ls.map((v) => LETTERS[v.line.slot]).join('、');
  const machines = view.lines.filter((v) => v.info.unit === 'machine' && v.status !== 'nofit');
  const noLine = view.lines.filter((v) => v.users.length === 0);
  const hot = (n: number) => (
    <Tag color="error" className="fade-in" style={{ marginInlineStart: 6, fontWeight: 400 }}>
      {tr('compare.hot', { n })}
    </Tag>
  );
  const sub = (text: string) => (
    <Typography.Text type="secondary" style={{ ...small, fontWeight: 400 }}>
      {text}
    </Typography.Text>
  );
  const you = { x: users, label: tr('compare.you', { n: f(users) }) };
  const tipUsers = (v: number) => tr('compare.tip.users', { n: f(Math.round(v)) });
  const { tps: hotTps, ttft: hotTtft } = view.hot;
  return (
    <>
      <div className="cmp-charts">
        <section data-testid="compare-chart-tps" style={{ minWidth: 0 }}>
          <div className="wb-h">
            {tr('compare.chart.tps')} {sub(tr('compare.zone.tps', { v: f(target.min) }))}
            {hotTps > 0 && hotTps >= hotTtft && hot(hotTps)}
          </div>
          <CompareChart
            series={usersSeries('tps')}
            x={{ min: 1, max: view.usersMax, log: true }}
            xTitle={tr('compare.x.users')}
            yTitle={tr('compare.y.tps')}
            band={{ y: target.min, dir: 'above' }}
            refLine={you}
            hover={hoverUsers}
            onHover={setHoverUsers}
            tip={{ x: tipUsers, y: (v) => tr('compare.tps', { v: f(v) }) }}
            label={tr('compare.aria', { title: tr('compare.chart.tps'), n: drawn.length })}
          />
        </section>
        <section data-testid="compare-chart-ttft" style={{ minWidth: 0 }}>
          <div className="wb-h">
            {tr('compare.chart.ttft')} {sub(tr('compare.zone.ttft', { v: f(target.ttft) }))}
            {hotTtft > 0 && hotTtft > hotTps && hot(hotTtft)}
          </div>
          <CompareChart
            series={usersSeries('ttft')}
            x={{ min: 1, max: view.usersMax, log: true }}
            xTitle={tr('compare.x.users')}
            yTitle={tr('compare.y.ttft')}
            band={{ y: target.ttft, dir: 'below' }}
            refLine={you}
            hover={hoverUsers}
            onHover={setHoverUsers}
            tip={{ x: tipUsers, y: (v) => tr('compare.ttft', { v: f(v, 1) }) }}
            label={tr('compare.aria', { title: tr('compare.chart.ttft'), n: drawn.length })}
          />
        </section>
      </div>
      <div className={'reveal' + (view.showCards ? ' on' : '')} inert={!view.showCards} aria-hidden={!view.showCards}>
        <div data-testid="compare-cards-chart">
          <div style={{ marginTop: 14 }}>
            <div className="wb-h">
              {tr('compare.chart.cards')} {sub(tr('compare.cards.hint', { users: f(users) }))}
            </div>
            {view.showCards && (
              <CompareChart
                series={cards}
                x={{ min: 1, max: view.cardsMax, log: false }}
                xTitle={tr('compare.x.cards')}
                yTitle={tr('compare.y.tps')}
                band={{ y: target.min, dir: 'above' }}
                hover={hoverCards}
                onHover={setHoverCards}
                tip={{ x: (v) => tr('compare.tip.cards', { n: f(Math.round(v)) }), y: (v) => tr('compare.tps', { v: f(v) }) }}
                label={tr('compare.aria', { title: tr('compare.chart.cards'), n: cards.length })}
              />
            )}
            {machines.length > 0 && (
              <Typography.Text type="secondary" style={{ ...small, display: 'block' }}>
                {tr('compare.machines', { letters: letters(machines) })}
              </Typography.Text>
            )}
          </div>
        </div>
      </div>
      {noLine.length > 0 && (
        <Typography.Text type="secondary" style={{ ...small, display: 'block', marginTop: 8 }}>
          <CloseCircleOutlined /> {tr('compare.noLine', { letters: letters(noLine) })}
        </Typography.Text>
      )}
    </>
  );
}
