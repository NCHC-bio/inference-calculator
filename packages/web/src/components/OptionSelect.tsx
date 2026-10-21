import { Select, Typography } from 'antd';
import { useState, type JSX, type ReactElement, type ReactNode } from 'react';
import { useT } from '../i18n';
import { useHoverNone } from '../media';

export type Opt = { value: string; label: string; desc?: string };

/** Value of the trailing 「自訂…」 option (never a bundle id: ids are kebab-case). */
export const CUSTOM_OPT = '__custom__';

type Props = {
  value: string;
  options: Opt[];
  onChange: (v: string) => void;
  ariaLabel: string;
  showSearch?: boolean;
  /** Minimum width of the field. */
  width?: number;
  /** Width of the option list (demo v8: wider than the field so descriptions get two short lines). */
  popupWidth?: number;
  onOpenChange?: (open: boolean) => void;
  /** Rendered above the option list (e.g. the model tier suggestion). */
  popupHeader?: ReactNode;
  /**
   * Trailing 「自訂…」 option with its description. `selected` shows it as the current value; picking it (even when
   * already selected) calls `onPick` instead of `onChange`.
   */
  custom?: { desc: string; selected: boolean; onPick: () => void };
  /** Shown when the search matches nothing; `close` closes the menu (e.g. before opening a dialog). */
  notFound?: (search: string, close: () => void) => ReactNode;
};

/**
 * antd's Select placements plus shiftX: a popup wider than the space right of a field (the 340 px model list on a
 * 390 px phone) slides left to stay inside the viewport instead of widening the page.
 */
const overflow = { adjustX: true, adjustY: true, shiftX: true, shiftY: true };
const PLACEMENTS = {
  bottomLeft: { points: ['tl', 'bl'], offset: [0, 4], overflow, htmlRegion: 'visible' as const, dynamicInset: true },
  bottomRight: { points: ['tr', 'br'], offset: [0, 4], overflow, htmlRegion: 'visible' as const, dynamicInset: true },
  topLeft: { points: ['bl', 'tl'], offset: [0, -4], overflow, htmlRegion: 'visible' as const, dynamicInset: true },
  topRight: { points: ['br', 'tr'], offset: [0, -4], overflow, htmlRegion: 'visible' as const, dynamicInset: true },
};

/**
 * Name with its description underneath. The description opens (grid 0fr → 1fr, design §3.6) only for the active
 * option (mouse or keyboard) and the selected one; with `(hover: none)` every description is open (design §3.2).
 */
function OptionLabel({ opt, on }: { opt: Opt; on: boolean }) {
  return (
    <div>
      <div>{opt.label}</div>
      {opt.desc && (
        <div className={'opt-desc' + (on ? ' on' : '')} aria-hidden={!on}>
          <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'normal' }}>
            {opt.desc}
          </Typography.Text>
        </div>
      )}
    </div>
  );
}

/**
 * Controlled Select whose options carry a one-line description (spec §8.3.3, demo v8 `optRender`). The active option
 * is tracked through `onActive`, which rc-select fires for both mouse hover and arrow-key moves. Open state and search
 * text are controlled here so the not-found entries can read the search and close the menu.
 */
export function OptionSelect({
  value,
  options,
  onChange,
  ariaLabel,
  showSearch,
  width,
  popupWidth,
  onOpenChange,
  popupHeader,
  custom,
  notFound,
}: Props): JSX.Element {
  const tr = useT();
  const hoverNone = useHoverNone();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const shown = custom?.selected ? CUSTOM_OPT : value;
  const all = custom ? [...options, { value: CUSTOM_OPT, label: tr('opt.custom'), desc: custom.desc }] : options;
  const openChange = (o: boolean) => {
    setOpen(o);
    if (!o) {
      setActive(null);
      setSearch('');
    }
    onOpenChange?.(o);
  };
  return (
    <Select<string, Opt>
      aria-label={ariaLabel}
      virtual={false}
      builtinPlacements={PLACEMENTS}
      open={open}
      value={shown}
      options={all}
      onChange={(v) => {
        if (v !== CUSTOM_OPT) onChange(v);
      }}
      onSelect={(v) => {
        setSearch('');
        if (v === CUSTOM_OPT) custom?.onPick();
      }}
      onActive={setActive}
      onOpenChange={openChange}
      showSearch={showSearch ? { optionFilterProp: 'label', searchValue: search, onSearch: setSearch } : false}
      style={{ minWidth: width }}
      popupMatchSelectWidth={popupWidth ?? false}
      styles={{ popup: { root: { maxWidth: 'calc(100vw - 32px)' } } }}
      optionRender={(o) => <OptionLabel opt={o.data} on={hoverNone || o.data.value === active || o.data.value === shown} />}
      notFoundContent={notFound ? notFound(search.trim(), () => openChange(false)) : undefined}
      popupRender={
        popupHeader
          ? (menu: ReactElement) => (
              <>
                {popupHeader}
                {menu}
              </>
            )
          : undefined
      }
    />
  );
}
