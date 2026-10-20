import { Alert, Typography } from 'antd';
import type { JSX } from 'react';
import { getBundle } from '../bundle';
import { useView } from '../compute/useResults';
import { useLang, useT } from '../i18n';
import { useCalc } from '../state/store';
import { RowDetail } from './RowDetail';
import { WHY } from './why';

/** Body under the have-mode answer line: full-load detail, or the error when nobody fits. */
export function HaveResult(): JSX.Element | null {
  const tr = useT();
  const lang = useLang();
  const [{ havePlatform, workload }] = useCalc();
  const view = useView();
  if (view.kind !== 'have') return null;
  const { expected, usage, detail, bottleneck, queueing } = view.result;
  if (expected.n === 0 || !usage) {
    return <Alert type="error" showIcon title={detail ?? tr('answer.have.none')} data-testid="have-error" style={{ marginTop: 12 }} />;
  }
  const bundle = getBundle();
  const n = new Intl.NumberFormat(lang).format(expected.n);
  return (
    <div data-testid="have-result" style={{ marginTop: 12 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
        {tr('have.full', { n })}
      </Typography.Text>
      <RowDetail usage={usage} unit={bundle.platforms[havePlatform]!.unit} demoText={bundle.workloads[workload]!.demoText} queueing={queueing} />
      {bottleneck !== null && (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
          {tr('have.next', { why: tr(WHY[bottleneck]) })}
        </Typography.Text>
      )}
    </div>
  );
}
