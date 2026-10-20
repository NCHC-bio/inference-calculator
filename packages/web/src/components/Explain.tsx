import { Popover } from 'antd';
import { cloneElement, useState, type JSX, type MouseEvent, type ReactElement, type ReactNode } from 'react';

type ClickProps = { onClick?: (e: MouseEvent) => void };

/**
 * hover、點擊／觸控、鍵盤焦點都會打開；子元素必須可以取得焦點（沒有的話包一層 tabIndex=0）。
 *
 * Hover and focus go through the Popover trigger. A click or tap only ever opens: with antd's own `click`
 * trigger, the focus that precedes a click opens the popover and the click then toggles it shut again.
 * It closes on mouse leave or blur (tapping elsewhere).
 */
export function Explain({ title, content, children }: { title?: ReactNode; content: ReactNode; children: ReactElement }): JSX.Element {
  const [open, setOpen] = useState(false);
  const child = children as ReactElement<ClickProps>;
  const trigger = cloneElement(child, {
    onClick: (e: MouseEvent) => {
      child.props.onClick?.(e);
      setOpen(true);
    },
  });
  return (
    <Popover title={title} content={content} trigger={['hover', 'focus']} open={open} onOpenChange={setOpen}>
      {trigger}
    </Popover>
  );
}
