import { DeleteOutlined } from '@ant-design/icons';
import { Button, Empty, List, Popconfirm, Typography } from 'antd';
import { useEffect, type JSX } from 'react';
import { useT } from '../../i18n';
import { clearMyModels, myModelKey, removeMyModel, saveMyModel, useMyModels, type MyModel } from '../../state/myModels';
import type { Action, CalcState } from '../../state/state';
import { useCalc } from '../../state/store';
import { CalcDrawer } from './CalcDrawer';

/** The store action that makes a saved model the current one: an import is read again at its commit (Ruling W1). */
export function myModelAction(m: MyModel): Action {
  return m.kind === 'hf'
    ? { type: 'customModel', value: { kind: 'hf', repo: m.repo, sha: m.sha } }
    : { type: 'customModel', value: { kind: 'manual', value: m.value } };
}

/** The saved entry of the current custom model, if it is one the user made (an import that answered, or manual). */
export function currentAsMyModel(c: CalcState['customModel']): MyModel | null {
  if (c?.kind === 'hf' && c.imported) return { kind: 'hf', repo: c.repo, sha: c.sha, name: c.imported.model.name };
  if (c?.kind === 'manual') return { kind: 'manual', value: c.value, name: c.value.name ?? '' };
  return null;
}

/** Saves every custom model the user makes (an import that answered, a manual entry) to their list (state/myModels). */
export function MyModelsSync(): null {
  const [s] = useCalc();
  const mine = currentAsMyModel(s.customModel);
  const key = mine ? myModelKey(mine) : null;
  useEffect(() => {
    if (mine) saveMyModel(mine);
    // The key identifies the model; re-saving on every render would only reorder the same entry.
  }, [key]);
  return null;
}

/** 「我的模型」: the user's saved models, to use again or remove one by one or all at once (design: lists in a Drawer). */
export function MyModelsDrawer(): JSX.Element {
  const tr = useT();
  const [, dispatch] = useCalc();
  const list = useMyModels();
  return (
    <CalcDrawer id="myModels" title={tr('my.title')}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>{tr('my.note')}</Typography.Paragraph>
      {list.length === 0 ? (
        <Empty description={tr('my.empty')} />
      ) : (
        <>
          <List
            data-testid="my-models"
            dataSource={list}
            rowKey={myModelKey}
            renderItem={(m) => (
              <List.Item
                className="fade-in"
                actions={[
                  <Button
                    key="use"
                    size="small"
                    onClick={() => {
                      dispatch(myModelAction(m));
                      dispatch({ type: 'dialog', id: null });
                    }}
                  >
                    {tr('my.use')}
                  </Button>,
                  <Button
                    key="remove"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    aria-label={tr('my.remove', { name: m.name })}
                    onClick={() => removeMyModel(myModelKey(m))}
                  />,
                ]}
              >
                <List.Item.Meta
                  title={<span style={{ overflowWrap: 'anywhere' }}>{m.name || tr('opt.custom')}</span>}
                  description={
                    <span style={{ overflowWrap: 'anywhere', fontSize: 12 }}>
                      {m.kind === 'hf' ? tr('my.desc.hf', { repo: m.repo, sha: m.sha.slice(0, 7) }) : tr('my.desc.manual')}
                    </span>
                  }
                />
              </List.Item>
            )}
          />
          <Popconfirm title={tr('my.clear.confirm')} okText={tr('my.clear')} cancelText={tr('my.cancel')} onConfirm={clearMyModels}>
            <Button danger style={{ marginTop: 12 }}>{tr('my.clear')}</Button>
          </Popconfirm>
        </>
      )}
    </CalcDrawer>
  );
}
