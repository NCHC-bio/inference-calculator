import { Divider } from 'antd';
import { Fragment, type JSX } from 'react';
import { getBundle } from '../bundle';
import { useView } from '../compute/useResults';
import { useT } from '../i18n';
import { workloadId } from '../state/state';
import { useCalc } from '../state/store';
import { PlatformRow, rowDetailId } from './PlatformRow';
import { RowDetail } from './RowDetail';

/** 每個平台一列（spec §8.3.3-4），照 bundle 的順序；catalog 平台。 */
export function PlatformList(): JSX.Element | null {
  const tr = useT();
  const [{ openRow, workload }, dispatch] = useCalc();
  const view = useView();
  if (view.kind !== 'need') return null;
  const { result } = view;
  const bundle = getBundle();
  const platforms = bundle.platforms;
  const demoText = bundle.workloads[workloadId(workload)]!.demoText;
  const byId = new Map(result.perPlatform.map((p) => [p.platform, p]));
  // Core's note says power is unverified; the bundle's TDP record says why (its `conflict`), when it has one.
  const powerNote = (note: string, hw: string) => {
    const tdp = bundle.hardware[hw]?.tdpW;
    return tdp?.value === null && tdp.conflict ? tr('detail.powerNote', { note, why: tdp.conflict }) : note;
  };
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
              users={view.users}
              best={result.best === id}
              open={open}
              onToggle={() => dispatch({ type: 'openRow', row: open ? null : id })}
            />
            {open && r.usage && (
              <RowDetail
                id={rowDetailId(id)}
                usage={r.usage}
                unit={platforms[id]!.unit}
                demoText={demoText}
                power={{ kw: r.powerKw, ...(r.powerNote !== undefined ? { note: powerNote(r.powerNote, platforms[id]!.hardware) } : {}) }}
                queueing={r.queueing}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
