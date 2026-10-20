import { App as AntApp, ConfigProvider, Segmented, theme } from 'antd';
import enUS from 'antd/locale/en_US';
import zhTWLocale from 'antd/locale/zh_TW';
import { useEffect, useState } from 'react';
import { getBundle } from './bundle';
import { useLang, useT } from './i18n';
import { antdTheme, useDarkMode } from './theme';

type Mode = 'need' | 'have';

/** antd does not paint body: sync page background, text colour and color-scheme from the theme tokens. */
function PageTheme({ dark }: { dark: boolean }) {
  const { token } = theme.useToken();
  const lang = useLang();
  useEffect(() => {
    const { body, documentElement } = document;
    body.style.background = token.colorBgLayout;
    body.style.color = token.colorText;
    documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }, [token.colorBgLayout, token.colorText, dark]);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return null;
}

function Shell() {
  const tr = useT();
  const [mode, setMode] = useState<Mode>('need');
  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: 16 }}>
      <Segmented<Mode>
        value={mode}
        onChange={setMode}
        options={[
          { value: 'need', label: tr('mode.need') },
          { value: 'have', label: tr('mode.have') },
        ]}
      />
      <footer style={{ marginTop: 24, opacity: 0.65 }}>
        {tr('footer.dataVersion', { version: getBundle().meta.dataVersion })}
      </footer>
    </main>
  );
}

export function App() {
  const dark = useDarkMode();
  const lang = useLang();
  return (
    <ConfigProvider
      theme={antdTheme(dark)}
      button={{ autoInsertSpace: false }}
      locale={lang === 'en' ? enUS : zhTWLocale}
    >
      <AntApp>
        <PageTheme dark={dark} />
        <Shell />
      </AntApp>
    </ConfigProvider>
  );
}
