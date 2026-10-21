import { Alert } from 'antd';
import type { JSX } from 'react';
import { useT } from '../../i18n';

/**
 * The NCHC model rule, shown first in every custom-model Drawer before anything is entered (spec §2.2, Ruling W12):
 * a user-entered model is never origin-checked and the user is not asked for its publisher, so the rule is stated
 * up front, whatever the model. Results using the model carry the same warning (CUSTOM_MODEL_WARNING).
 */
export function CustomModelWarning(): JSX.Element {
  const tr = useT();
  return (
    <Alert
      data-testid="custom-model-warning"
      type="warning"
      showIcon
      style={{ marginBottom: 16 }}
      title={<strong>{tr('custom.warning.title')}</strong>}
      description={tr('custom.warning')}
    />
  );
}
