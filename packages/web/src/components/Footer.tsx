import { BugOutlined, ExportOutlined, GithubOutlined } from '@ant-design/icons';
import { Button, Divider, Flex, Typography } from 'antd';
import type { JSX } from 'react';
import { getBundle } from '../bundle';
import { useT } from '../i18n';
import { GITHUB_REPO, NCHC_ISERVICE } from '../reportModel';
import { useCalc } from '../state/store';
import { Explain } from './Explain';

const external = { target: '_blank', rel: 'noopener noreferrer' } as const;

/**
 * Who runs the site and where to go next (design v10: NCHC → iService, GitHub, report), then the data version and the
 * honest notes about what is not estimated (design §4 item 7).
 */
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
    <footer>
      <Divider style={{ margin: '20px 0 12px' }} />
      <Flex align="center" justify="space-between" gap={12} wrap="wrap">
        <a className="nchc" href={NCHC_ISERVICE} {...external}>
          <img className="nchc-logo" src={`${import.meta.env.BASE_URL}nchc-logo.png`} alt="NCHC" height={30} />
          <Flex vertical style={{ lineHeight: 1.35 }}>
            <Typography.Text style={{ fontSize: 13 }}>{tr('footer.nchc')}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {tr('footer.iservice')} <ExportOutlined />
            </Typography.Text>
          </Flex>
        </a>
        <Flex gap={16} align="center" style={{ fontSize: 13 }}>
          <Typography.Link href={GITHUB_REPO} {...external}>
            <GithubOutlined /> {tr('footer.github')}
          </Typography.Link>
          <Typography.Link href={`${GITHUB_REPO}/issues/new/choose`} {...external}>
            <BugOutlined /> {tr('footer.report')}
          </Typography.Link>
        </Flex>
      </Flex>
      <Flex gap={16} wrap="wrap" align="center" style={{ marginTop: 10, fontSize: 12 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {tr('footer.dataVersion', { version: getBundle().meta.dataVersion })}
        </Typography.Text>
        <Button type="link" size="small" style={{ padding: 0, fontSize: 12 }} onClick={() => dispatch({ type: 'dialog', id: 'accuracy' })}>
          {tr('footer.accuracy')}
        </Button>
        {note(tr('footer.cost'), tr('footer.cost.tip'))}
        {note(tr('footer.p95'), tr('footer.p95.tip'))}
      </Flex>
    </footer>
  );
}
