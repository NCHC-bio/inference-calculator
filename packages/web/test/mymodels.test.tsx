import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { beforeEach, describe, expect, it } from 'vitest';
import { getBundle } from '../src/bundle';
import { ImportProgress } from '../src/components/ImportProgress';
import { MyModelsDrawer, MyModelsSync } from '../src/components/drawers/MyModelsDrawer';
import { endImportProgress, reportImportStep, startImportProgress } from '../src/state/importProgress';
import { MY_MODELS_KEY, resetMyModelsCache, saveMyModel } from '../src/state/myModels';
import { DIALOGS, defaultState, reduce, type Action, type CalcState } from '../src/state/state';
import { StoreProvider, useCalc } from '../src/state/store';

const b = getBundle();
let send: (a: Action) => void = () => {};
let latest: CalcState | null = null;
function Probe() {
  const [s, dispatch] = useCalc();
  send = dispatch;
  latest = s;
  return null;
}
const renderWith = (ui: React.ReactElement) =>
  render(
    <StoreProvider>
      <ConfigProvider button={{ autoInsertSpace: false }}>
        <AntApp>
          {ui}
          <Probe />
        </AntApp>
      </ConfigProvider>
    </StoreProvider>,
  );

beforeEach(() => {
  localStorage.clear();
  resetMyModelsCache();
  history.replaceState(null, '', '/');
});

describe('dialogs', () => {
  it('the reducer opens every dialog id there is (a missing one made a click do nothing)', () => {
    for (const id of DIALOGS) expect(reduce(b, defaultState(b), { type: 'dialog', id }).dialog).toBe(id);
  });
});

describe('my models (stored in this browser)', () => {
  it('an import that answered and a manual model are saved; the drawer uses, removes and clears them', async () => {
    saveMyModel({ kind: 'hf', repo: 'org/older', sha: 'abc1234def', name: 'older' });
    renderWith(<><MyModelsSync /><MyModelsDrawer /></>);
    act(() => send({ type: 'customModel', value: { kind: 'manual', value: { name: 'My Arch', totalParamsB: 7, layers: 32, heads: 32, kvHeads: 8, headDim: 128, hidden: 4096 } } }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(MY_MODELS_KEY)!)).toHaveLength(2));
    // Nothing secret is stored: no token, no computed model.
    expect(localStorage.getItem(MY_MODELS_KEY)).not.toMatch(/token|hf_/i);

    act(() => send({ type: 'dialog', id: 'myModels' }));
    const list = await screen.findByTestId('my-models');
    expect(list).toHaveTextContent('My Arch');
    expect(list).toHaveTextContent('我匯入的模型 · org/older@abc1234');
    await userEvent.click(within(list).getAllByRole('button', { name: '使用' })[1]!);
    await waitFor(() => expect(latest?.customModel).toEqual({ kind: 'hf', repo: 'org/older', sha: 'abc1234def' }));

    act(() => send({ type: 'dialog', id: 'myModels' }));
    await userEvent.click(await screen.findByRole('button', { name: '刪除 older' }));
    await waitFor(() => expect(screen.getByTestId('my-models')).not.toHaveTextContent('older'));
    await userEvent.click(screen.getByRole('button', { name: '全部清除' }));
    const confirm = await waitFor(() => document.querySelector<HTMLElement>('.ant-popconfirm')!);
    await userEvent.click(within(confirm).getByRole('button', { name: '全部清除' }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(MY_MODELS_KEY)!)).toEqual([]));
  });

  it('a broken or unavailable store is an empty list, never an error', () => {
    localStorage.setItem(MY_MODELS_KEY, '{not json');
    resetMyModelsCache();
    renderWith(<MyModelsSync />);
    expect(latest?.customModel).toBeNull();
  });
});

describe('ImportProgress', () => {
  it('shows each step as it happens: done ones ticked, the current one running', () => {
    renderWith(<ImportProgress repo="org/m-GGUF" />);
    act(() => {
      startImportProgress('org/m-GGUF');
      reportImportStep('model-info', 'org/m-GGUF');
      reportImportStep('gguf-base', 'org/m');
    });
    expect(screen.getByTestId('import-progress')).toHaveTextContent('正在從 Hugging Face 匯入 org/m-GGUF');
    expect(screen.getAllByTestId('import-step-done')[0]).toHaveTextContent('讀取模型資訊（org/m-GGUF）');
    expect(screen.getByTestId('import-step-current')).toHaveTextContent('GGUF 檔：改讀原始模型 org/m');
    act(() => endImportProgress());
  });
});
