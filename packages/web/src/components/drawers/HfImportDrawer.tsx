import { GithubOutlined } from '@ant-design/icons';
import { fetchHfModel, type HfFetchResult } from '@nchc/data/hf';
import { HF_REPO_RE } from '@nchc/schema';
import { Alert, App as AntApp, Button, Form, Input, Space, Spin, Typography } from 'antd';
import { useEffect, useRef, useState, type JSX } from 'react';
import { useT, type MsgKey, type TFn } from '../../i18n';
import type { Action, CalcState } from '../../state/state';
import { useCalc } from '../../state/store';
import { reportModelUrl } from '../../reportModel';
import { endImportProgress, reportImportStep, startImportProgress } from '../../state/importProgress';
import { ImportProgress } from '../ImportProgress';
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
  'not-language-model': 'hf.err.notLlm',
};
/** The offline notice belongs to the pending import: dropped when it is (effect cleanup). */
const REFETCH_KEY = 'hf-refetch';
/** A failure notice outlives the import it reports (the model falls back, the effect re-runs): only the user closes it. */
const FAIL_KEY = 'hf-import-failed';

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
  // Each step is reported (state/importProgress) so the answer says what is happening.
  startImportProgress(repo);
  const r = await fetchHfModel(repo, {
    fetch: browserFetch,
    onProgress: reportImportStep,
    ...(opts.token ? { token: opts.token } : {}),
    ...(opts.revision ? { revision: opts.revision } : {}),
  });
  endImportProgress();
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
      // Every failure stays until the user closes it (a toast vanished before it could be read). An import that could
      // not be read is a calculator bug, so its notice keeps the pre-filled bug report.
      const bug = r.status === 'unparsable' || r.status === 'gguf';
      notification.error({
        key: FAIL_KEY,
        title: tr('hf.refetchFail', { repo, message: tr(ERR[r.status], { task: r.task ?? '' }) }),
        // A bug lists what was missing, others their detail; "not a language model" is said in full by its title.
        ...(r.status !== 'not-language-model'
          ? { description: <span style={{ overflowWrap: 'anywhere' }}>{bug && r.missing?.length ? tr('hf.missing', { list: r.missing.join(tr('hf.listSep')) }) : r.message}</span> }
          : {}),
        duration: 0,
        ...(bug
          ? {
              actions: (
                <Button
                  size="small"
                  icon={<GithubOutlined />}
                  href={reportModelUrl(r.repo ?? repo, r.sha, r.message, 'error')}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="hf-report"
                >
                  {tr('hf.report')}
                </Button>
              ),
            }
          : {}),
      });
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
 * A failed import, once (CLAUDE.md "Goal for imported models"): an import that could not be read at all (unparsable,
 * or a GGUF repo with no base model to read) is a calculator bug, so it lists what was missing and offers a
 * pre-filled bug report; anything else (gated, not found, offline) shows its own title and the detail.
 */
function ErrorView({ err, repo, tr }: { err: Failure; repo: string; tr: TFn }) {
  const sep = tr('hf.listSep');
  const bug = err.status === 'unparsable' || err.status === 'gguf';
  const description = (
    <>
      {err.missing && err.missing.length > 0 && err.status !== 'not-language-model'
        ? <div style={{ overflowWrap: 'anywhere' }}>{tr('hf.missing', { list: err.missing.join(sep) })}</div>
        : <div style={{ overflowWrap: 'anywhere' }}>{err.message}</div>}
      {bug && (
        <Space orientation="vertical" size={2} style={{ marginTop: 8 }}>
          <Button
            size="small"
            icon={<GithubOutlined />}
            href={reportModelUrl(err.repo ?? repo, err.sha, err.message, 'error')}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="hf-report"
          >
            {tr('hf.report')}
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{tr('hf.report.help')}</Typography.Text>
        </Space>
      )}
    </>
  );
  return (
    <Alert data-testid="hf-error" type="error" showIcon className="fade-in" style={{ marginBottom: 12 }} title={tr(ERR[err.status], { task: err.task ?? '' })} description={description} />
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
  const [lastRepo, setLastRepo] = useState('');
  const { busy } = run;

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
    // Estimated parts: said at once; the answer's notice lists them and offers the support request.
    const added = r.action.type === 'customModel' ? r.action.value : null;
    const estimated = added?.kind === 'hf' && (added.imported?.model.estimates?.length ?? 0) > 0;
    if (estimated) void message.warning(tr('hf.imported.estimated', { repo }));
    else void message.success(tr('hf.imported', { repo }));
  };

  return (
    <Spin spinning={busy}>
      <CustomModelWarning />
      {pending && <Alert type="info" showIcon style={{ marginBottom: 12 }} title={tr('hf.reload', { repo: pending.repo })} />}
      {err && <ErrorView err={err} repo={lastRepo} tr={tr} />}
      {busy && lastRepo && <ImportProgress repo={lastRepo} />}
      <Form<Values>
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
