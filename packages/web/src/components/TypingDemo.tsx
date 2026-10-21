import { HourglassOutlined } from '@ant-design/icons';
import { theme, Typography } from 'antd';
import { useEffect, useRef, useState, type JSX } from 'react';
import { useLang, useT } from '../i18n';
import { useMediaQuery } from '../media';
import { Explain } from './Explain';

/** Animation clock (layout only, no model values). */
const TICK_MS = 50;
const HOLD_MS = 1500;
/** The demo never waits longer than this for the first word (the caption states the real wait). */
const WAIT_CAP_MS = 6000;

const num = (lang: string, n: number, digits: number) => new Intl.NumberFormat(lang, { maximumFractionDigits: digits }).format(n);

type Clock = { waitedMs: number; pos: number; holdMs: number };
const START: Clock = { waitedMs: 0, pos: 0, holdMs: 0 };

/** One tick: wait for the first word, then add TICK_MS × tokPerSec chars, then hold and replay. */
function step(c: Clock, len: number, tokPerSec: number, ttftSec: number): Clock {
  if (c.pos === 0 && c.waitedMs < Math.min(ttftSec * 1000, WAIT_CAP_MS)) return { ...c, waitedMs: c.waitedMs + TICK_MS };
  if (c.pos < len) return { ...c, pos: Math.min(len, c.pos + (TICK_MS * tokPerSec) / 1000) };
  const holdMs = c.holdMs + TICK_MS;
  return holdMs > HOLD_MS ? START : { ...c, holdMs };
}

/**
 * 先等 ttftSec（示範最多 6 秒），再以 tokPerSec 個字／秒逐字出現（1 字 = 1 token，近似，popover 註明）。
 * 進度逐格累加：速度或首字改變時從目前進度以新速度接續，不重置；只有文字或 `reset`（列）改變才從頭開始。
 * 文字放完後停 1.5 秒再重播；reduced motion 時直接顯示全文，並寫出等待秒數與速度。
 * The clock is a setInterval tick (fake-timer friendly); the speed is read from a ref so a change never restarts it.
 */
export function TypingDemo({ text, tokPerSec, ttftSec, reset }: { text: string; tokPerSec: number; ttftSec: number; reset?: string }): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const { token } = theme.useToken();
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const animate = !reduced && tokPerSec > 0 && Number.isFinite(tokPerSec) && Number.isFinite(ttftSec) && ttftSec >= 0;
  const chars = [...text];
  const speed = useRef({ tokPerSec, ttftSec, len: chars.length });
  speed.current = { tokPerSec, ttftSec, len: chars.length };
  const run = `${text}|${reset ?? ''}`;
  // The clock belongs to one run: a new run reads as the start until its own interval ticks.
  const [clock, setClock] = useState({ run, c: START });

  useEffect(() => {
    setClock({ run, c: START });
    if (!animate) return;
    const id = setInterval(() => {
      const { len, tokPerSec: tps, ttftSec: ttft } = speed.current;
      setClock((x) => ({ run, c: step(x.run === run ? x.c : START, len, tps, ttft) }));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [run, animate]);

  const c = clock.run === run ? clock.c : START;
  // Small epsilon so float sums of per-tick steps are not lost at whole chars.
  const shown = animate ? Math.min(chars.length, Math.floor(c.pos + 1e-9)) : chars.length;
  const waiting = animate && c.pos === 0 && c.waitedMs < Math.min(ttftSec * 1000, WAIT_CAP_MS);

  const vars = { ttft: num(lang, ttftSec, 1), tps: num(lang, tokPerSec, 0) };
  return (
    <div>
      <div
        style={{
          background: token.colorFillTertiary,
          borderRadius: token.borderRadiusLG,
          padding: '10px 12px',
          minHeight: 88,
          lineHeight: 1.7,
        }}
      >
        {waiting && (
          <Typography.Text type="secondary" data-testid="waiting" className="fade-in">
            <HourglassOutlined spin /> {tr('typing.waiting')}
          </Typography.Text>
        )}
        <span data-testid="typed">{chars.slice(0, shown).join('')}</span>
        {animate && !waiting && (
          <span
            aria-hidden
            style={{ display: 'inline-block', width: 2, height: '1em', marginLeft: 1, verticalAlign: 'text-bottom', background: token.colorPrimary }}
          />
        )}
      </div>
      <Explain content={<div style={{ maxWidth: 280 }}>{tr('typing.tip', vars)}</div>}>
        <Typography.Text type="secondary" tabIndex={0} style={{ fontSize: 12, cursor: 'help' }}>
          {tr('typing.caption', vars)}
        </Typography.Text>
      </Explain>
    </div>
  );
}
