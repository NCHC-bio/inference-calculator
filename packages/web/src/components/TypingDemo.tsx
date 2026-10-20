import { theme, Typography } from 'antd';
import { useEffect, useState, type JSX } from 'react';
import { useLang, useT } from '../i18n';
import { useMediaQuery } from '../media';
import { Explain } from './Explain';

/** Animation clock (layout only, no model values). */
const TICK_MS = 50;
const HOLD_MS = 1500;

const num = (lang: string, n: number, digits: number) => new Intl.NumberFormat(lang, { maximumFractionDigits: digits }).format(n);

/** 先等 ttftSec，再以 tokPerSec 個字／秒逐字出現（1 字 = 1 token，計畫者判斷，popover 註明是近似）。
 *  文字放完後停 1.5 秒再重播；reduced motion 時直接顯示全文，並寫出等待秒數與速度。
 *  The clock is a setInterval tick counter (fake-timer friendly); it restarts on any prop change and stops on unmount. */
export function TypingDemo({ text, tokPerSec, ttftSec }: { text: string; tokPerSec: number; ttftSec: number }): JSX.Element {
  const tr = useT();
  const lang = useLang();
  const { token } = theme.useToken();
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const animate = !reduced && tokPerSec > 0 && Number.isFinite(tokPerSec) && Number.isFinite(ttftSec) && ttftSec >= 0;
  const run = `${text}|${tokPerSec}|${ttftSec}|${animate}`;
  // Ticks belong to one run: a new run reads as 0 until its own interval ticks.
  const [clock, setClock] = useState({ run, ticks: 0 });

  useEffect(() => {
    setClock({ run, ticks: 0 });
    if (!animate) return;
    const id = setInterval(() => setClock((c) => ({ run, ticks: c.run === run ? c.ticks + 1 : 1 })), TICK_MS);
    return () => clearInterval(id);
  }, [run, animate]);

  const chars = [...text];
  let shown = chars.length;
  let waiting = false;
  if (animate) {
    const waitMs = ttftSec * 1000;
    const cycle = waitMs + (chars.length * 1000) / tokPerSec + HOLD_MS;
    const t = ((clock.run === run ? clock.ticks : 0) * TICK_MS) % cycle;
    waiting = t < waitMs;
    // Small epsilon so exact tick boundaries are not lost to float rounding.
    shown = waiting ? 0 : Math.min(chars.length, Math.floor(((t - waitMs) * tokPerSec) / 1000 + 1e-9));
  }

  const vars = { ttft: num(lang, ttftSec, 1), tps: num(lang, tokPerSec, 0) };
  return (
    <div>
      <div
        style={{
          background: token.colorFillTertiary,
          borderRadius: token.borderRadius,
          padding: '10px 12px',
          minHeight: 84,
          lineHeight: 1.7,
        }}
      >
        {waiting && (
          <Typography.Text type="secondary" data-testid="waiting">
            ⏳ {tr('typing.waiting')}
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
