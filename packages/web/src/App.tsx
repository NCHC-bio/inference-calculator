import { Alert, App as AntApp, Button, ConfigProvider, Flex, Segmented, theme, Typography } from 'antd';
import enUS from 'antd/locale/en_US';
import zhTWLocale from 'antd/locale/zh_TW';
import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { getBundle } from './bundle';
import { useLang, useT, type Lang } from './i18n';
import { StoreProvider, useCalc } from './state/store';
import { AnswerLine } from './components/AnswerLine';
import { PlatformList } from './components/PlatformList';
import { BasisModal } from './components/BasisModal';
import { CiteModal } from './components/CiteModal';
import { Sentence } from './components/Sentence';
import { AccuracyDrawer } from './components/drawers/AccuracyDrawer';
import { FunnelDrawer } from './components/drawers/FunnelDrawer';
import { HardwareDrawer } from './components/drawers/HardwareDrawer';
import { HfImportDrawer, HfRefetch } from './components/drawers/HfImportDrawer';
import { ManualModelDrawer } from './components/drawers/ManualModelDrawer';
import { SpeedDrawer } from './components/drawers/SpeedDrawer';
import { VerifyDrawer } from './components/drawers/VerifyDrawer';
import { WorkloadDrawer } from './components/drawers/WorkloadDrawer';
import { antdTheme, useDarkMode, useReducedMotion } from './theme';

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

function ErrorAlert({ error }: { error: unknown }) {
  const tr = useT();
  return (
    <Alert
      type="error"
      showIcon
      role="alert"
      title={tr('app.error')}
      description={error instanceof Error ? error.message : String(error)}
      style={{ margin: 16 }}
    />
  );
}

/**
 * Last line of defence (final review C1): an error thrown while rendering shows an alert instead of React unmounting
 * the whole page. Input problems are handled before this (CoreInputError → error view); this catches the rest.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(error, info.componentStack);
  }

  render(): ReactNode {
    return this.state.error === null ? this.props.children : <ErrorAlert error={this.state.error} />;
  }
}

/** Title and the language switch (demo v8 header). */
function Header() {
  const tr = useT();
  const [{ lang }, dispatch] = useCalc();
  return (
    <Flex component="header" align="center" justify="space-between" gap={8} wrap="wrap" style={{ marginBottom: 8 }}>
      <Typography.Title level={1} style={{ fontSize: 16, margin: 0 }}>
        {tr('app.title')}
      </Typography.Title>
      <Segmented<Lang>
        size="small"
        aria-label={tr('aria.lang')}
        value={lang}
        onChange={(l) => dispatch({ type: 'lang', lang: l })}
        options={[
          { value: 'zh-TW', label: tr('lang.zhTW') },
          { value: 'en', label: tr('lang.en') },
        ]}
      />
    </Flex>
  );
}

/** Data version and the rarely used audit entries (design §4 item 7). */
function Footer() {
  const tr = useT();
  const [, dispatch] = useCalc();
  return (
    <Flex component="footer" gap={16} wrap="wrap" align="center" style={{ marginTop: 24, fontSize: 12 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {tr('footer.dataVersion', { version: getBundle().meta.dataVersion })}
      </Typography.Text>
      <Button type="link" size="small" style={{ padding: 0, fontSize: 12 }} onClick={() => dispatch({ type: 'dialog', id: 'accuracy' })}>
        {tr('footer.accuracy')}
      </Button>
    </Flex>
  );
}

/** Every Drawer and Modal; each opens from the store's `dialog` (design §3.3, §4 item 8). */
function Dialogs() {
  return (
    <>
      <BasisModal />
      <CiteModal />
      <VerifyDrawer />
      <FunnelDrawer />
      <WorkloadDrawer />
      <SpeedDrawer />
      <HfImportDrawer />
      <ManualModelDrawer />
      <HardwareDrawer />
      <AccuracyDrawer />
      <HfRefetch />
    </>
  );
}

function Shell() {
  return (
    <main style={{ maxWidth: 980, margin: '0 auto', padding: 16 }}>
      <Header />
      <Sentence />
      <AnswerLine />
      <PlatformList />
      <Dialogs />
      <Footer />
    </main>
  );
}

function ThemedApp() {
  const dark = useDarkMode();
  const reduced = useReducedMotion();
  const lang = useLang();
  return (
    <ConfigProvider
      theme={antdTheme(dark, reduced)}
      button={{ autoInsertSpace: false }}
      locale={lang === 'en' ? enUS : zhTWLocale}
    >
      <AntApp>
        <PageTheme dark={dark} />
        <ErrorBoundary>
          <Shell />
        </ErrorBoundary>
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
