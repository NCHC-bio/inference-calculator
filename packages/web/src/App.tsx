import { App as AntApp, ConfigProvider, Segmented, theme } from 'antd';
import enUS from 'antd/locale/en_US';
import zhTWLocale from 'antd/locale/zh_TW';
import { useEffect } from 'react';
import { getBundle } from './bundle';
import { useLang, useT } from './i18n';
import { StoreProvider, useCalc } from './state/store';
import type { Mode } from './state/state';
import { AnswerLine } from './components/AnswerLine';
import { PlatformList } from './components/PlatformList';
import { BasisDrawer } from './components/BasisDrawer';
import { Sentence } from './components/Sentence';
import { antdTheme, useDarkMode } from './theme';

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
  const [{ mode }, dispatch] = useCalc();
  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: 16 }}>
      <Segmented<Mode>
        value={mode}
        onChange={(m) => dispatch({ type: 'mode', mode: m })}
        options={[
          { value: 'need', label: tr('mode.need') },
          { value: 'have', label: tr('mode.have') },
        ]}
      />
      <Sentence />
      <AnswerLine />
      {mode === 'need' && <PlatformList />}
      <BasisDrawer />
      <footer style={{ marginTop: 24, opacity: 0.65 }}>
        {tr('footer.dataVersion', { version: getBundle().meta.dataVersion })}
      </footer>
    </main>
  );
}

function ThemedApp() {
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

export function App() {
  return (
    <StoreProvider>
      <ThemedApp />
    </StoreProvider>
  );
}
