import { GithubOutlined } from '@ant-design/icons';
import { fetchHfModel, type HfFetchResult, type UnsupportedFeature } from '@nchc/data/hf';
import { HF_REPO_RE } from '@nchc/schema';
import { Alert, App as AntApp, Button, Collapse, Form, Input, Space, Spin, Typography } from 'antd';
import { useEffect, useRef, useState, type JSX } from 'react';
import { useT, type MsgKey, type TFn } from '../../i18n';
import type { Action, CalcState } from '../../state/state';
import { useCalc } from '../../state/store';
import { reportModelUrl } from '../../reportModel';
import { CalcDrawer } from './CalcDrawer';
import { CustomModelWarning } from './CustomModelWarning';

type Failure = Extract<HfFetchResult, { ok: false }>;
const ERR: Record<Failure['status'], MsgKey> = {
  denied: 'hf.err.denied',
  'not-found': 'hf.err.notFound',
  invalid: 'hf.err.invalid',
  unparsable: 'hf.err.unparsable',
  network: 'hf.err.network',
  gguf: 'hf.err.gguf',
};
/** Every recognised but unmodelled feature has a name in each language (issue #17). */
const FEATURE: Record<UnsupportedFeature, MsgKey> = {
  'linear-attention': 'hf.feature.linear-attention',
  'short-conv': 'hf.feature.short-conv',
  'dense-and-moe': 'hf.feature.dense-and-moe',
  'moe-layout': 'hf.feature.moe-layout',
  'heterogeneous-blocks': 'hf.feature.heterogeneous-blocks',
  'compressed-attention': 'hf.feature.compressed-attention',
  'cross-layer-kv': 'hf.feature.cross-layer-kv',
  'sparse-indexer': 'hf.feature.sparse-indexer',
  'lookup-tables': 'hf.feature.lookup-tables',
  'memory-layers': 'hf.feature.memory-layers',
  'recurrent-depth': 'hf.feature.recurrent-depth',
  'nested-config': 'hf.feature.nested-config',
  'native-quant': 'hf.feature.native-quant',
  'unknown-layer-type': 'hf.feature.unknown-layer-type',
};
const REFETCH_KEY = 'hf-refetch';

/** The browser's fetch, typed for fetchHfModel (only huggingface.co sees the token). */
const browserFetch = (url: string, init?: { headers?: Record<string, string> }) => fetch(url, init);

/** An HF model in the URL waiting to be refetched (Ruling W1): imported is absent. */
export function pendingHf(s: CalcState): Extract<CalcState['customModel'], { kind: 'hf' }> | null {
  const c = s.customModel;
  return c?.kind === 'hf' && !c.imported ? c : null;
}

/**
 * Fetches `repo` and turns the answer into the store action; null on failure. `revision` pins the commit (a URL
 * reload refetches the sha it stored).
 */
export async function importHf(
  repo: string,
  opts: { token?: string; revision?: string },
): Promise<{ ok: true; action: Action } | Failure> {
  // No origin: a user-imported model is not origin-checked and gets the custom-model warning (Ruling W12).
  const r = await fetchHfModel(repo, {
    fetch: browserFetch,
    ...(opts.token ? { token: opts.token } : {}),
    ...(opts.revision ? { revision: opts.revision } : {}),
  });
  if (!r.ok) return r;
  return {
    ok: true,
    action: { type: 'customModel', value: { kind: 'hf', repo: r.repo, sha: r.sha, imported: { model: r.model, source: r.source } } },
  };
}

/**
 * Ruling W1: an HF model from the URL (no `imported`) is fetched again at its stored sha; on failure an error message
 * and the default model. A gated repo opens the HF Drawer so the user can paste a token (Ruling W12).
 * A network failure is transient: the model (and so the link in the address bar) is kept, and a notification offers
 * Retry or the default model (review I3).
 */
export function HfRefetch(): null {
  const tr = useT();
  const [s, dispatch] = useCalc();
  const { message, notification } = AntApp.useApp();
  const [attempt, setAttempt] = useState(0);
  const pending = pendingHf(s);
  const repo = pending?.repo;
  const sha = pending?.sha;
  useEffect(() => {
    if (repo === undefined || sha === undefined) return;
    let live = true;
    void importHf(repo, { revision: sha }).then((r) => {
      if (!live) return;
      if (r.ok) {
        dispatch(r.action);
        return;
      }
      if (r.status === 'denied') {
        dispatch({ type: 'dialog', id: 'hf', hfQuery: repo });
        return;
      }
      if (r.status === 'network') {
        notification.error({
          key: REFETCH_KEY,
          title: tr('hf.refetchNetwork', { repo }),
          description: r.message,
          duration: 0,
          actions: (
            <Space>
              <Button
                size="small"
                onClick={() => {
                  notification.destroy(REFETCH_KEY);
                  dispatch({ type: 'customModel', value: null });
                }}
              >
                {tr('hf.refetch.default')}
              </Button>
              <Button
                size="small"
                type="primary"
                onClick={() => {
                  notification.destroy(REFETCH_KEY);
                  setAttempt((a) => a + 1);
                }}
              >
                {tr('hf.refetch.retry')}
              </Button>
            </Space>
          ),
        });
        return;
      }
      void message.error(tr('hf.refetchFail', { repo, message: `${tr(ERR[r.status])}（${r.message}）` }));
      dispatch({ type: 'customModel', value: null });
    });
    return () => {
      live = false;
      notification.destroy(REFETCH_KEY);
    };
    // tr / message / notification only report the error; a language switch must not refetch. `attempt` is Retry.
  }, [repo, sha, dispatch, attempt]);
  return null;
}

/**
 * One readable answer per failure (issue #17): an unparsable model names its unmodelled features in the user's language
 * (technical details one step away) and offers a pre-filled report; a GGUF repo offers the model it came from; anything
 * else shows its own title and the importer's detail once.
 */
function ErrorView({ err, repo, tr, onUseBase }: { err: Failure; repo: string; tr: TFn; onUseBase: (base: string) => void }) {
  const sep = tr('hf.listSep');
  let description: JSX.Element;
  if (err.status === 'unparsable') {
    const unsupported = err.unsupported ?? [];
    const explained = new Set(unsupported.flatMap((u) => u.fields));
    const rest = (err.missing ?? []).filter((m) => !explained.has(m));
    const details = unsupported.length > 0 ? unsupported.map((u) => u.detail) : [err.message];
    description = (
      <>
        {unsupported.length > 0 && (
          <div>
            {tr('hf.unsupported', { list: unsupported.map((u) => tr(FEATURE[u.feature])).join(sep) })}
            {tr('hf.unsupported.why')}
          </div>
        )}
        {rest.length > 0 && <div style={{ overflowWrap: 'anywhere' }}>{tr('hf.missing', { list: rest.join(sep) })}</div>}
        {unsupported.length > 0 && (
          <Collapse
            ghost
            size="small"
            style={{ margin: '4px -16px 0' }}
            items={[{
              key: 'details',
              label: tr('hf.details'),
              children: (
                <ul data-testid="hf-error-details" style={{ margin: 0, paddingInlineStart: 18, overflowWrap: 'anywhere', fontSize: 12 }}>
                  {details.map((d) => <li key={d}>{d}</li>)}
                </ul>
              ),
            }]}
          />
        )}
        <Space orientation="vertical" size={2} style={{ marginTop: 8 }}>
          <Button
            size="small"
            icon={<GithubOutlined />}
            href={reportModelUrl(err.repo ?? repo, err.sha, err.message)}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="hf-report"
          >
            {tr('hf.report')}
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{tr('hf.report.help')}</Typography.Text>
        </Space>
      </>
    );
  } else if (err.status === 'gguf') {
    const bases = err.baseModels ?? [];
    description = bases.length === 0 ? <div>{tr('hf.gguf.none')}</div> : (
      <>
        <div>{tr('hf.gguf.hint')}</div>
        <Space wrap size={4} style={{ marginTop: 6 }}>
          {bases.map((b) => (
            <Button key={b} size="small" onClick={() => onUseBase(b)}>{tr('hf.gguf.use', { repo: b })}</Button>
          ))}
        </Space>
      </>
    );
  } else {
    description = (
      <>
        <div style={{ overflowWrap: 'anywhere' }}>{err.message}</div>
        {err.missing && err.missing.length > 0 && <div>{tr('hf.missing', { list: err.missing.join(sep) })}</div>}
      </>
    );
  }
  return (
    <Alert data-testid="hf-error" type="error" showIcon className="fade-in" style={{ marginBottom: 12 }} title={tr(ERR[err.status])} description={description} />
  );
}

type Values = { repo: string };

/**
 * One import at a time, owned by the Drawer: `begin` starts attempt n, `live(n)` is false once the Drawer closed (or a
 * newer attempt began), so a late answer neither dispatches nor toasts.
 */
type Run = { busy: boolean; begin: () => number; live: (n: number) => boolean; end: (n: number) => void };

function Body({ run }: { run: Run }): JSX.Element {
  const tr = useT();
  const [s, dispatch] = useCalc();
  const { message } = AntApp.useApp();
  const pending = pendingHf(s);
  // The token lives in this component only: never in the store, the URL or storage (spec §8.3.2).
  const [token, setToken] = useState('');
  // A gated repo from the link (W12) arrives here pending: the token field is shown at once.
  const [needToken, setNeedToken] = useState(pending !== null);
  const [err, setErr] = useState<Failure | null>(null);
  const [form] = Form.useForm<Values>();
  const [lastRepo, setLastRepo] = useState('');
  const { busy } = run;
  // GGUF → the original model in the repo field, ready to import.
  const useBase = (base: string) => {
    setErr(null);
    form.setFieldsValue({ repo: base });
  };

  const submit = async (v: Values) => {
    if (busy) return;
    const repo = v.repo.trim();
    const n = run.begin();
    setErr(null);
    setLastRepo(repo);
    const r = await importHf(repo, {
      token: token.trim() || undefined,
      revision: pending && pending.repo === repo ? pending.sha : undefined,
    });
    if (!run.live(n)) return;
    run.end(n);
    if (!r.ok) {
      setErr(r);
      if (r.status === 'denied') setNeedToken(true);
      return;
    }
    dispatch(r.action);
    dispatch({ type: 'dialog', id: null });
    void message.success(tr('hf.imported', { repo }));
  };

  return (
    <Spin spinning={busy}>
      <CustomModelWarning />
      {pending && <Alert type="info" showIcon style={{ marginBottom: 12 }} title={tr('hf.reload', { repo: pending.repo })} />}
      {err && <ErrorView err={err} repo={lastRepo} tr={tr} onUseBase={useBase} />}
      <Form<Values>
        form={form}
        name="hfImport"
        layout="vertical"
        initialValues={{ repo: s.hfQuery || pending?.repo || '' }}
        onFinish={(v) => void submit(v)}
      >
        <Form.Item
          name="repo"
          label={tr('hf.repo')}
          extra={tr('hf.note')}
          rules={[{ required: true, message: tr('form.required') }, { pattern: HF_REPO_RE, message: tr('hf.repo.invalid') }]}
          normalize={(x: string) => x.trimStart()}
        >
          <Input placeholder={tr('hf.repo.ph')} autoComplete="off" />
        </Form.Item>
        {needToken && (
          <Form.Item label={tr('hf.token')} htmlFor="hf_token" extra={tr('hf.token.help')} className="fade-in">
            <Input.Password id="hf_token" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          </Form.Item>
        )}
      </Form>
      {!needToken && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {tr('hf.tokenLater')}
        </Typography.Text>
      )}
    </Spin>
  );
}

/**
 * 「從 Hugging Face 匯入模型」(spec §8.3.2, design §6.3): repo, publisher and country (both asked, never guessed), then
 * fetchHfModel in the browser. Starts from the model search text (`hfQuery`) or the URL's model waiting to be refetched;
 * closing without importing drops that model (Ruling W1).
 */
export function HfImportDrawer(): JSX.Element {
  const tr = useT();
  const [s, dispatch] = useCalc();
  const [busy, setBusy] = useState(false);
  const attempt = useRef(0);
  const open = s.dialog === 'hf';
  useEffect(() => {
    if (open) return;
    // Closed (any way): a running import is abandoned.
    attempt.current++;
    setBusy(false);
  }, [open]);
  const run: Run = {
    busy,
    begin: () => {
      setBusy(true);
      return ++attempt.current;
    },
    live: (n) => attempt.current === n,
    end: (n) => {
      if (attempt.current === n) setBusy(false);
    },
  };

  return (
    <CalcDrawer
      id="hf"
      title={tr('hf.title')}
      extra={
        <Button type="primary" htmlType="submit" form="hfImport" disabled={busy}>
          {tr('hf.import')}
        </Button>
      }
      onClose={() => {
        attempt.current++;
        if (pendingHf(s)) dispatch({ type: 'customModel', value: null });
      }}
    >
      <Body run={run} />
    </CalcDrawer>
  );
}
