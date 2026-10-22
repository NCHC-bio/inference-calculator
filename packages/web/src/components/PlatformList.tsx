import { PlusOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Collapse, Divider, type CollapseProps } from 'antd';
import { useRef, type JSX } from 'react';
import { getBundle } from '../bundle';
import { useDeferredState, useMain } from '../compute/useResults';
import { useT } from '../i18n';
import { CUSTOM_PLATFORMS_MAX, isPlainLine } from '../state/state';
import { useCalc } from '../state/store';
import { BestMarker } from './BestMarker';
import { Explain } from './Explain';
import { CompareCheck, CustomActions, RowExtra, RowName, rowInfo, WhyTag } from './PlatformRow';
import { Workbench } from './Workbench';

type Item = NonNullable<CollapseProps['items']>[number];

/** How long 復原 is offered after custom hardware is deleted. */
export const UNDO_SEC = 5;

/**
 * 平台列表（design §4 item 4）: one antd Collapse item per platform in bundle order, then custom hardware; a 「自建」
 * divider before the first self-hosted row; the add-hardware button last. Only the platform name toggles a row
 * (`collapsible: 'header'`); infeasible rows are disabled and have no arrow. Inputs sit in the header `extra`.
 */
export function PlatformList(): JSX.Element | null {
  const tr = useT();
  const [current, dispatch] = useCalc();
  // Rows describe the deferred inputs; their platforms are read from the same state.
  const s = useDeferredState();
  const view = useMain();
  const wrap = useRef<HTMLDivElement>(null);
  const undoSeq = useRef(0);
  const live = useRef(current);
  live.current = current;
  const { message } = AntApp.useApp();
  if (view.kind !== 'main') return null;
  const b = getBundle();
  const best = view.result.best;

  /**
   * Custom hardware is removed at once; a message offers 復原 for UNDO_SEC (user decision, v8 minor 5), which puts it
   * back at its index with the count and open state it had.
   */
  const remove = (index: number) => {
    const value = current.customPlatforms[index];
    if (!value) return;
    const key = `custom:${index}`;
    const override = current.overrides[key];
    const wasOpen = current.openRow === key;
    dispatch({ type: 'removePlatform', index });
    const mk = `undo-hardware-${++undoSeq.current}`;
    const undo = () => {
      message.destroy(mk);
      // Read at click time: other hardware may have been added since (fix round C).
      if (live.current.customPlatforms.length >= CUSTOM_PLATFORMS_MAX) {
        void message.warning(tr('hw.full', { n: CUSTOM_PLATFORMS_MAX }));
        return;
      }
      dispatch({ type: 'restorePlatform', index, value, ...(override ? { override } : {}), wasOpen });
    };
    void message.open({
      key: mk,
      type: 'info',
      duration: UNDO_SEC,
      content: (
        <span data-testid="undo-hardware">
          <span>{tr('hw.removed', { name: value.name })}</span>
          <Button type="link" size="small" onClick={undo}>
            {tr('hw.undo')}
          </Button>
        </span>
      ),
    });
  };

  const items: Item[] = [];
  let divider = false;
  for (const r of view.rows) {
    const info = rowInfo(b, s, r.row);
    if (info.self && !divider) {
      divider = true;
      items.push({
        key: '__self',
        className: 'row-divider',
        showArrow: false,
        collapsible: 'disabled',
        label: (
          <Divider titlePlacement="start" plain style={{ margin: 0, fontSize: 12 }}>
            {tr('platforms.self')}
          </Divider>
        ),
      });
    }
    const attrs = { 'data-testid': 'platform-row', 'data-row': r.row, 'data-best': String(best === r.row) };
    const onEdit = () => dispatch({ type: 'dialog', id: 'hardware', editingPlatform: info.custom });
    const onDelete = () => info.custom !== null && remove(info.custom);
    const compared = current.compare.some((l) => l.row === r.row && isPlainLine(l));
    const onCompare = () => dispatch({ type: 'compareToggle', row: r.row });
    if (r.kind === 'infeasible') {
      const extra = (
        <div className="row-extra">
          <WhyTag why={r.why} detail={r.detail} />
          <CompareCheck checked={compared} onChange={onCompare} infeasible />
          {info.custom !== null && <CustomActions onEdit={onEdit} onDelete={onDelete} />}
        </div>
      );
      // Not `collapsible: 'disabled'`: that marks the whole header aria-disabled, so assistive tech would read a custom
      // row's edit / delete as disabled. 'icon' without an arrow leaves nothing that toggles and no aria-disabled region;
      // `row-infeasible` keeps the disabled look (fix round B).
      items.push({ key: r.row, ...attrs, className: 'row-infeasible', showArrow: false, collapsible: 'icon', label: <RowName info={info} />, extra });
      continue;
    }
    items.push({
      key: r.row,
      ...attrs,
      collapsible: 'header',
      label: <RowName info={info} />,
      extra: (
        <RowExtra
          r={r}
          info={info}
          users={view.users}
          onSuggest={() => dispatch({ type: 'override', row: r.row, value: null })}
          onSet={(gpus) => dispatch({ type: 'override', row: r.row, value: { gpus } })}
          onEdit={onEdit}
          onDelete={onDelete}
          compared={compared}
          onCompare={onCompare}
        />
      ),
      children: <Workbench row={r} />,
    });
  }
  const full = current.customPlatforms.length >= CUSTOM_PLATFORMS_MAX;
  const add = (
    <Button
      type="dashed"
      block
      disabled={full}
      icon={<PlusOutlined />}
      style={{ marginTop: 8, whiteSpace: 'normal', height: 'auto' }}
      onClick={() => dispatch({ type: 'dialog', id: 'hardware', editingPlatform: null })}
    >
      {tr('platforms.addHardware')}
    </Button>
  );
  const open = view.rows.find((r) => r.row === current.openRow && r.kind === 'ok')?.row;

  return (
    <div ref={wrap} data-testid="platform-list" style={{ position: 'relative' }}>
      <BestMarker container={wrap} rowKey={best} />
      <Collapse
        className="rows"
        ghost
        accordion
        // A closed row's workbench unmounts after its leave motion, so its typing clock, tweens and chart
        // transitions stop (v8 minor 1); Workbench keeps its last bench only for that leave animation.
        destroyOnHidden
        activeKey={open === undefined ? [] : [open]}
        onChange={(keys) => dispatch({ type: 'openRow', row: keys[0] ?? null })}
        items={items}
      />
      {full ? (
        // A disabled button gets no pointer events: the hint hangs on a focusable wrapper (v8 minor 3).
        <Explain content={<div style={{ maxWidth: 280 }}>{tr('platforms.addFull', { n: CUSTOM_PLATFORMS_MAX })}</div>}>
          <span data-testid="add-hardware" tabIndex={0} style={{ display: 'block', cursor: 'not-allowed' }}>
            {add}
          </span>
        </Explain>
      ) : (
        add
      )}
    </div>
  );
}
