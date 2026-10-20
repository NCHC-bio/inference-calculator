import { App as AntApp, ConfigProvider, Segmented } from 'antd';
import enUS from 'antd/locale/en_US';
import zhTWLocale from 'antd/locale/zh_TW';
import { useState } from 'react';
import { getBundle } from './bundle';
import { langFromUrl, useT } from './i18n';
import { antdTheme, useDarkMode } from './theme';

type Mode = 'need' | 'have';

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
  return (
    <ConfigProvider
      theme={antdTheme(dark)}
      button={{ autoInsertSpace: false }}
      locale={langFromUrl() === 'en' ? enUS : zhTWLocale}
    >
      <AntApp>
        <Shell />
      </AntApp>
    </ConfigProvider>
  );
}
