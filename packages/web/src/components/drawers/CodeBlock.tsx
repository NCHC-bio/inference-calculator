import { theme, Typography } from 'antd';
import type { JSX } from 'react';
import { useT } from '../../i18n';

/**
 * Core's one-line commands, one flag per line: a ` \` line break before every ` --`. `#` comment lines stay as they
 * are. Text only: replacing ` \\\n  ` with a space gives the input back.
 */
export function formatCommand(cmd: string): string {
  return cmd
    .split('\n')
    .map((line) => (line.trimStart().startsWith('#') ? line : line.replaceAll(' --', ' \\\n  --')))
    .join('\n');
}

/**
 * core's verifyCommand as the verify Drawer's two blocks: 「1. 啟動服務」 is the comments and the first command line
 * (the server), 「2. 壓測」 the rest (the benchmark). `parts.join('\n')` is the input.
 */
export function splitVerify(cmd: string): [string, string] {
  const lines = cmd.split('\n');
  const serve = lines.findIndex((l) => !l.trimStart().startsWith('#'));
  if (serve < 0 || serve === lines.length - 1) return [cmd, ''];
  return [lines.slice(0, serve + 1).join('\n'), lines.slice(serve + 1).join('\n')];
}

/**
 * A command in a code block (demo v8 `CodeBlock`): monospace, line breaks kept, a copy icon top right; a long line
 * scrolls inside the box only.
 */
export function CodeBlock({ code }: { code: string }): JSX.Element {
  const { token } = theme.useToken();
  const tr = useT();
  return (
    <div style={{ position: 'relative', margin: '6px 0 4px' }}>
      <pre
        style={{
          margin: 0,
          padding: '12px 44px 12px 14px',
          background: token.colorFillTertiary,
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadiusLG,
          fontFamily: token.fontFamilyCode,
          fontSize: 12.5,
          lineHeight: 1.7,
          overflowX: 'auto',
          whiteSpace: 'pre',
          color: token.colorText,
        }}
      >
        <code>{code}</code>
      </pre>
      <Typography.Text
        copyable={{ text: code, tooltips: [tr('code.copy'), tr('code.copied')] }}
        style={{ position: 'absolute', top: 8, right: 10 }}
      />
    </div>
  );
}
