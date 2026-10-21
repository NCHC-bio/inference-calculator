import { Alert, Typography } from 'antd';
import type { JSX } from 'react';
import { useBench } from '../../compute/useResults';
import { useT } from '../../i18n';
import { useCalc } from '../../state/store';
import { CalcDrawer } from './CalcDrawer';
import { CodeBlock, formatCommand, splitVerify } from './CodeBlock';

const small = { fontSize: 12 };

/** core's verify command of the open row split into its two steps (design §4 item 8). */
function Body(): JSX.Element {
  const tr = useT();
  const [{ openRow }] = useCalc();
  const bench = useBench(openRow);
  if (!bench) return <Typography.Text type="secondary">{tr('verify.noRow')}</Typography.Text>;
  const { verifyCommand: cmd, verifyNote: note } = bench.perf;
  const [serve, run] = cmd === '' ? ['', ''] : splitVerify(cmd);
  return (
    <div data-testid="verify-body">
      {note && <Alert type="info" showIcon title={note} style={{ marginBottom: 12 }} />}
      {cmd === '' ? (
        !note && <Typography.Text type="secondary">{tr('verify.none')}</Typography.Text>
      ) : (
        <>
          <Typography.Text type="secondary" style={small}>
            {tr('verify.intro')}
          </Typography.Text>
          <div style={{ marginTop: 12 }}>
            <Typography.Text strong>{tr('verify.serve')}</Typography.Text>
          </div>
          <CodeBlock code={formatCommand(serve)} />
          {run !== '' && (
            <>
              <div style={{ marginTop: 12 }}>
                <Typography.Text strong>{tr('verify.bench')}</Typography.Text>
              </div>
              <CodeBlock code={formatCommand(run)} />
            </>
          )}
          <Typography.Text type="secondary" style={small}>
            {tr('verify.read')}
          </Typography.Text>
        </>
      )}
    </div>
  );
}

export function VerifyDrawer(): JSX.Element {
  const tr = useT();
  return (
    <CalcDrawer id="verify" title={tr('verify.title')}>
      <Body />
    </CalcDrawer>
  );
}
