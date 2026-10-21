import { PlusOutlined } from '@ant-design/icons';
import { Button, Collapse, Divider, type CollapseProps } from 'antd';
import { useRef, type JSX } from 'react';
import { getBundle } from '../bundle';
import { useDeferredState, useMain } from '../compute/useResults';
import { useT } from '../i18n';
import { CUSTOM_PLATFORMS_MAX } from '../state/state';
import { useCalc } from '../state/store';
import { BestMarker } from './BestMarker';
import { Explain } from './Explain';
import { CustomActions, RowExtra, RowName, rowInfo, WhyTag } from './PlatformRow';
import { Workbench } from './Workbench';

type Item = NonNullable<CollapseProps['items']>[number];

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
  if (view.kind !== 'main') return null;
  const b = getBundle();
  const best = view.result.best;

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
    const onDelete = () => info.custom !== null && dispatch({ type: 'removePlatform', index: info.custom });
    if (r.kind === 'infeasible') {
      const extra = (
        <div className="row-extra">
          <WhyTag why={r.why} detail={r.detail} />
          {info.custom !== null && <CustomActions onEdit={onEdit} onDelete={onDelete} />}
        </div>
      );
      items.push({ key: r.row, ...attrs, showArrow: false, collapsible: 'disabled', label: <RowName info={info} />, extra });
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
