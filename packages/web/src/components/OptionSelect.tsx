import { Select, Tooltip, Typography } from 'antd';
import { useState, type JSX, type ReactElement, type ReactNode } from 'react';
import { useHoverNone } from '../media';

export type Opt = { value: string; label: string; desc?: string };

type Props = {
  value: string;
  options: Opt[];
  onChange: (v: string) => void;
  ariaLabel: string;
  showSearch?: boolean;
  width?: number;
  onOpenChange?: (open: boolean) => void;
  /** Rendered above the option list (e.g. the model tier suggestion). */
  popupHeader?: ReactNode;
};

/** Name with its description on a second line: the touch layout, where nothing can be hovered. */
function InlineOption({ opt }: { opt: Opt }) {
  return (
    <div style={{ whiteSpace: 'normal' }}>
      <div>{opt.label}</div>
      {opt.desc && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {opt.desc}
        </Typography.Text>
      )}
    </div>
  );
}

/** Name only; the description shows in a Tooltip while the option is active (mouse over or keyboard). */
function TooltipOption({ opt, active }: { opt: Opt; active: boolean }) {
  if (!opt.desc) return <div>{opt.label}</div>;
  return (
    <Tooltip title={opt.desc} open={active} placement="right">
      <div>{opt.label}</div>
    </Tooltip>
  );
}

/**
 * Controlled Select whose options carry a one-line description (spec §8.3.3). The active option is tracked
 * through `onActive`, which rc-select fires for both mouse hover and arrow-key moves.
 */
export function OptionSelect({ value, options, onChange, ariaLabel, showSearch, width, onOpenChange, popupHeader }: Props): JSX.Element {
  const hoverNone = useHoverNone();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  return (
    <Select<string, Opt>
      aria-label={ariaLabel}
      variant="underlined"
      size="large"
      value={value}
      options={options}
      onChange={onChange}
      onActive={setActive}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setActive(null);
        onOpenChange?.(o);
      }}
      showSearch={showSearch ? { optionFilterProp: 'label' } : false}
      style={{ minWidth: width }}
      popupMatchSelectWidth={false}
      styles={{ popup: { root: { maxWidth: 380 } } }}
      optionRender={(o) =>
        hoverNone ? <InlineOption opt={o.data} /> : <TooltipOption opt={o.data} active={open && active === o.data.value} />
      }
      popupRender={
        popupHeader
          ? (menu: ReactElement) => (
              <>
                <div style={{ padding: '4px 8px 6px' }}>{popupHeader}</div>
                {menu}
              </>
            )
          : undefined
      }
    />
  );
}
