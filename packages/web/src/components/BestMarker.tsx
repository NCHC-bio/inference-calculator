import { theme } from 'antd';
import { useLayoutEffect, useRef, useState, type JSX, type RefObject } from 'react';

type Box = { top: number; height: number; on: boolean };
const NONE: Box = { top: 0, height: 0, on: false };

/** The header of the outermost platform row `rowKey` inside `container` (never a nested Collapse's). */
const headerOf = (container: HTMLElement, rowKey: string): HTMLElement | null => {
  // Attribute value in double quotes: escape `"` and `\` (jsdom has no CSS.escape).
  const v = rowKey.replace(/["\\]/g, (c) => `\\${c}`);
  return container.querySelector<HTMLElement>(`.rows > .ant-collapse-item[data-row="${v}"] > .ant-collapse-header`);
};

/**
 * The best row's left colour bar and background (design §3.6, FLIP): one absolutely positioned marker that measures the
 * best row's header and moves there by CSS `top` / `height` transitions, so a change of best row slides instead of
 * jumping. Re-measured after every render and whenever the container resizes (rows expanding, wrapping).
 */
export function BestMarker({ container, rowKey }: { container: RefObject<HTMLElement | null>; rowKey: string | null }): JSX.Element {
  const { token } = theme.useToken();
  const [box, setBox] = useState<Box>(NONE);
  const self = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    // On mount the container's ref is not attached yet (child layout effects run first); the marker is its child.
    const wrap = container.current ?? self.current?.parentElement;
    if (!wrap) return;
    const update = () => {
      const el = rowKey === null ? null : headerOf(wrap, rowKey);
      let next = NONE;
      if (el) {
        const a = wrap.getBoundingClientRect();
        const b = el.getBoundingClientRect();
        next = { top: Math.round(b.top - a.top), height: Math.round(b.height), on: true };
      }
      setBox((x) => (x.top === next.top && x.height === next.height && x.on === next.on ? x : next));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    return () => ro.disconnect();
  });

  return (
    <div
      ref={self}
      aria-hidden
      data-testid="best-marker"
      data-row={rowKey ?? ''}
      className="best-marker"
      style={{
        top: box.top,
        height: box.height,
        opacity: box.on ? 1 : 0,
        borderColor: token.colorPrimary,
        background: token.colorFillTertiary,
        borderRadius: token.borderRadiusLG,
      }}
    />
  );
}
