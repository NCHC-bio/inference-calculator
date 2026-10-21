import { Button, Flex, Typography } from 'antd';
import type { JSX } from 'react';
import { getBundle } from '../bundle';
import { useT } from '../i18n';
import { useCalc } from '../state/store';
import { Explain } from './Explain';

/** Data version and the honest notes about what is not estimated (design §4 item 7). */
export function Footer(): JSX.Element {
  const tr = useT();
  const [, dispatch] = useCalc();
  const note = (label: string, tip: string) => (
    <Explain content={<div style={{ maxWidth: 280 }}>{tip}</div>}>
      <Typography.Text type="secondary" tabIndex={0} className="help-text" style={{ fontSize: 12 }}>
        {label}
      </Typography.Text>
    </Explain>
  );
  return (
    <Flex component="footer" gap={16} wrap="wrap" align="center" style={{ marginTop: 12, fontSize: 12 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {tr('footer.dataVersion', { version: getBundle().meta.dataVersion })}
      </Typography.Text>
      <Button type="link" size="small" style={{ padding: 0, fontSize: 12 }} onClick={() => dispatch({ type: 'dialog', id: 'accuracy' })}>
        {tr('footer.accuracy')}
      </Button>
      {note(tr('footer.cost'), tr('footer.cost.tip'))}
      {note(tr('footer.p95'), tr('footer.p95.tip'))}
    </Flex>
  );
}
