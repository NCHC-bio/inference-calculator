import { Divider } from 'antd';
import { Fragment, type JSX } from 'react';
import { getBundle } from '../bundle';
import { useView } from '../compute/useResults';
import { useT } from '../i18n';
import { useCalc } from '../state/store';
import { PlatformRow } from './PlatformRow';

/** 每個平台一列（spec §8.3.3-4），照 bundle 的順序；只在 need 模式顯示。 */
export function PlatformList(): JSX.Element | null {
  const tr = useT();
  const [{ openRow, users }, dispatch] = useCalc();
  const view = useView();
  if (view.kind !== 'need') return null;
  const { result } = view;
  const platforms = getBundle().platforms;
  const byId = new Map(result.perPlatform.map((p) => [p.platform, p]));
  const firstSelf = Object.keys(platforms).find((id) => platforms[id]!.group === 'self');
  return (
    <div data-testid="platform-list" style={{ marginTop: 12 }}>
      {Object.keys(platforms).map((id) => {
        const r = byId.get(id);
        if (!r) return null;
        const open = openRow === id && r.expected.ok;
        return (
          <Fragment key={id}>
            {id === firstSelf && (
              <Divider titlePlacement="start" plain style={{ margin: '8px 0', fontSize: 12 }}>
                {tr('platforms.self')}
              </Divider>
            )}
            <PlatformRow
              r={r}
              users={users}
              best={result.best === id}
              open={open}
              onToggle={() => dispatch({ type: 'openRow', id: open ? null : id })}
            />
            {/* Task 8: <RowDetail> renders here when `open`. */}
          </Fragment>
        );
      })}
    </div>
  );
}
