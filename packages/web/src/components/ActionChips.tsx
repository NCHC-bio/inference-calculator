import { BulbOutlined } from '@ant-design/icons';
import { Button, Flex, Typography } from 'antd';
import type { JSX } from 'react';
import type { SuggestedAction } from '../compute/actions';
import { useLang, useT } from '../i18n';

/** Raw action vars → display strings: parameter counts keep one decimal, everything else is a whole number. */
function formatVars(lang: string, vars: SuggestedAction['vars']): Record<string, string> {
  return Object.fromEntries(
    Object.entries(vars).map(([k, v]) => [
      k,
      typeof v === 'number' ? new Intl.NumberFormat(lang, { maximumFractionDigits: k === 'params' ? 1 : 0 }).format(v) : v,
    ]),
  );
}

/**
 * 建議動作（design §4.5）：未達標時「想用這些卡達標，可以：」，卡數多於建議時「多出來的資源可以：」；
 * 每個按鈕依序 dispatch 它的 `apply`。No actions → nothing.
 */
export function ActionChips({ actions, ok, onApply }: { actions: SuggestedAction[]; ok: boolean; onApply: (a: SuggestedAction) => void }): JSX.Element | null {
  const tr = useT();
  const lang = useLang();
  if (actions.length === 0) return null;
  return (
    <div className="fade-in" data-testid="actions" style={{ marginTop: 12 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        <BulbOutlined /> {tr(ok ? 'wb.actions.extra' : 'wb.actions.miss')}
      </Typography.Text>
      <Flex gap={8} wrap="wrap" style={{ marginTop: 6 }}>
        {actions.map((a) => (
          <Button
            key={a.key}
            data-testid="action-chip"
            size="small"
            style={{ whiteSpace: 'normal', height: 'auto', textAlign: 'left' }}
            onClick={() => onApply(a)}
          >
            {tr(a.label, formatVars(lang, a.vars))}
          </Button>
        ))}
      </Flex>
    </div>
  );
}
