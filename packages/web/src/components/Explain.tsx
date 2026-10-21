import { Popover } from 'antd';
import {
  cloneElement,
  useEffect,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

/**
 * A press inside the popup must not move focus off a focused trigger: the blur would close the popup (focus trigger)
 * and its leave motion turns off pointer events, so the click on a link inside it would be lost (seen in Chromium after
 * a click or tap opened it). Form fields still take focus.
 */
function keepFocus(e: MouseEvent): void {
  const t = e.target;
  if (t instanceof Element && t.closest('input, textarea, select, [contenteditable]')) return;
  e.preventDefault();
}

type TriggerProps = { onClick?: (e: MouseEvent) => void; onPointerDown?: (e: PointerEvent) => void };

/**
 * hover、點擊／觸控、鍵盤焦點都會打開；子元素必須可以取得焦點（沒有的話包一層 tabIndex=0）。
 *
 * Hover and focus go through the Popover trigger. A mouse click only opens it: the pointer is already hovering, so a
 * click must not close what hover opened (leaving closes it). A tap or pen press toggles it relative to its state when
 * that pointer interaction began, so the focus that precedes a tap (focus opens) does not get re-closed by the tap. While open, a pointerdown outside both trigger and popup closes it (touch devices often neither focus
 * a tapped button nor fire a reliable mouseleave), and so does Escape (WCAG 1.4.13).
 */
export function Explain({
  title,
  content,
  children,
  open: openProp,
  onOpenChange,
}: {
  title?: ReactNode;
  content: ReactNode;
  children: ReactElement;
  /** Controlled open state (e.g. a link inside the popup closes it); uncontrolled when omitted. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}): JSX.Element {
  const [inner, setInner] = useState(false);
  const open = openProp ?? inner;
  const setOpen = onOpenChange ?? setInner;
  const popupRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const triggerDown = useRef<{ event: Event; wasOpen: boolean; mouse: boolean } | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: Event) => {
      if (triggerDown.current?.event === e) return;
      const t = e.target;
      if (t instanceof Node && (popupRef.current?.contains(t) || titleRef.current?.contains(t))) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const child = children as ReactElement<TriggerProps>;
  const trigger = cloneElement(child, {
    onPointerDown: (e: PointerEvent) => {
      child.props.onPointerDown?.(e);
      triggerDown.current = { event: e.nativeEvent, wasOpen: openRef.current, mouse: e.pointerType === 'mouse' };
    },
    onClick: (e: MouseEvent) => {
      child.props.onClick?.(e);
      // Mouse click: open only. Touch / pen: toggle from the state before this press. Keyboard click (no pointerdown):
      // toggle now.
      const down = triggerDown.current;
      triggerDown.current = null;
      if (down?.mouse) setOpen(true);
      else setOpen(!(down ? down.wasOpen : openRef.current));
    },
  });
  return (
    <Popover
      title={title && <div ref={titleRef}>{title}</div>}
      content={
        <div ref={popupRef} onMouseDown={keepFocus}>
          {content}
        </div>
      }
      trigger={['hover', 'focus']}
      open={open}
      onOpenChange={setOpen}
    >
      {trigger}
    </Popover>
  );
}
