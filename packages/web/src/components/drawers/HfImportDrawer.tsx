import { fetchHfModel, type HfFetchResult } from '@nchc/data/hf';
import { HF_REPO_RE, type Origin } from '@nchc/schema';
import { Alert, App as AntApp, Button, Form, Input, Space, Spin, Typography } from 'antd';
import { useEffect, useRef, useState, type JSX } from 'react';
import { useT, type MsgKey, type TFn } from '../../i18n';
import type { Action, CalcState } from '../../state/state';
import { useCalc } from '../../state/store';
import { CalcDrawer } from './CalcDrawer';

type Failure = Extract<HfFetchResult, { ok: false }>;
const ERR: Record<Failure['status'], MsgKey> = {
  denied: 'hf.err.denied',
  'not-found': 'hf.err.notFound',
  invalid: 'hf.err.invalid',
  unparsable: 'hf.err.unparsable',
  network: 'hf.err.network',
};
const COUNTRY = /^[A-Z]{2}$/;
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
  origin: Origin,
  opts: { token?: string; revision?: string },
): Promise<{ ok: true; action: Action } | Failure> {
  const r = await fetchHfModel(repo, {
    fetch: browserFetch,
    origin,
    ...(opts.token ? { token: opts.token } : {}),
    ...(opts.revision ? { revision: opts.revision } : {}),
  });
  if (!r.ok) return r;
  return {
    ok: true,
    action: { type: 'customModel', value: { kind: 'hf', repo: r.repo, sha: r.sha, imported: { model: r.model, source: r.source }, origin } },
  };
}

/**
 * Ruling W1: an HF model from the URL (no `imported`) is fetched again at its stored sha with its stored origin; on
 * failure an error message and the default model. Without a stored origin the HF Drawer opens to ask for it.
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
  const developer = pending?.origin?.developer;
  const country = pending?.origin?.country;
  useEffect(() => {
    if (repo === undefined || sha === undefined) return;
    if (developer === undefined || country === undefined) {
      dispatch({ type: 'dialog', id: 'hf', hfQuery: repo });
      return;
    }
    let live = true;
    void importHf(repo, { developer, country }, { revision: sha }).then((r) => {
      if (!live) return;
      if (r.ok) {
        dispatch(r.action);
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
  }, [repo, sha, developer, country, dispatch, attempt]);
  return null;
}

function ErrorView({ err, tr }: { err: Failure; tr: TFn }) {
  return (
    <Alert
      data-testid="hf-error"
      type="error"
      showIcon
      style={{ marginBottom: 12 }}
      title={tr(ERR[err.status])}
      description={
        <>
          <div style={{ overflowWrap: 'anywhere' }}>{err.message}</div>
          {err.missing && err.missing.length > 0 && <div>{tr('hf.missing', { list: err.missing.join('、') })}</div>}
        </>
      }
    />
  );
}

type Values = { repo: string; developer: string; country: string };

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
  const [needToken, setNeedToken] = useState(false);
  const [err, setErr] = useState<Failure | null>(null);
  const { busy } = run;

  const submit = async (v: Values) => {
    if (busy) return;
    const repo = v.repo.trim();
    const n = run.begin();
    setErr(null);
    const r = await importHf(repo, { developer: v.developer.trim(), country: v.country.trim() }, {
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
      {pending && <Alert type="info" showIcon style={{ marginBottom: 12 }} title={tr('hf.reload', { repo: pending.repo })} />}
      {err && <ErrorView err={err} tr={tr} />}
      <Form<Values>
        name="hfImport"
        layout="vertical"
        initialValues={{ repo: s.hfQuery || pending?.repo || '', developer: pending?.origin?.developer ?? '', country: pending?.origin?.country ?? '' }}
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
        <Form.Item name="developer" label={tr('hf.developer')} rules={[{ required: true, whitespace: true, message: tr('form.required') }]}>
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="country"
          label={tr('hf.country')}
          extra={tr('hf.origin.help')}
          normalize={(x: string) => x.toUpperCase()}
          rules={[{ required: true, message: tr('form.required') }, { pattern: COUNTRY, message: tr('hf.country.invalid') }]}
        >
          <Input maxLength={2} autoComplete="off" style={{ width: 120 }} />
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
