import { CopyOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Modal, theme, Typography } from 'antd';
import type { JSX } from 'react';
import { getBundle } from '../bundle';
import { useDeferredState, useMain } from '../compute/useResults';
import { useT } from '../i18n';
import { useCalc } from '../state/store';
import { citeText } from './citeText';

/**
 * Text the user can paste into a proposal or report (design §3.3: a Modal like 依據). The copy button sits in the
 * footer so it stays in view however long the text is; the text scrolls inside 70vh.
 */
export function CiteModal(): JSX.Element {
  const tr = useT();
  const [{ dialog }, dispatch] = useCalc();
  const s = useDeferredState();
  const view = useMain();
  const { token } = theme.useToken();
  const { message } = AntApp.useApp();
  const text = view.kind === 'main' ? citeText(getBundle(), s, view.result, tr) : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      void message.success(tr('cite.copied'));
    } catch {
      void message.error(tr('cite.copyFail'));
    }
  };
  return (
    <Modal
      title={tr('cite.title')}
      open={dialog === 'cite'}
      onCancel={() => dispatch({ type: 'dialog', id: null })}
      width={640}
      styles={{ body: { maxHeight: '70vh', overflowY: 'auto' } }}
      footer={
        // Nothing to cite (no result yet, or an input error): there is nothing to copy (v8 minor 4).
        <Button type="primary" icon={<CopyOutlined />} disabled={text.trim() === ''} onClick={() => void copy()}>
          {tr('cite.copy')}
        </Button>
      }
    >
      <Typography.Paragraph
        data-testid="cite-text"
        style={{
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          background: token.colorFillTertiary,
          padding: 12,
          borderRadius: 8,
          marginBottom: 0,
        }}
      >
        {text}
      </Typography.Paragraph>
    </Modal>
  );
}
