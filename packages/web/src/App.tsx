import { DesktopOutlined, GithubOutlined, MoonOutlined, ReloadOutlined, SunOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, ConfigProvider, Dropdown, Flex, Segmented, theme, Tooltip, Typography } from 'antd';
import enUS from 'antd/locale/en_US';
import zhTWLocale from 'antd/locale/zh_TW';
import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { GITHUB_REPO } from './reportModel';
import { useLang, useT, type Lang } from './i18n';
import { StoreProvider, useCalc } from './state/store';
import { AnswerLine } from './components/AnswerLine';
import { CompareCard } from './components/CompareCard';
import { Footer } from './components/Footer';
import { PlatformList } from './components/PlatformList';
import { BasisModal } from './components/BasisModal';
import { CiteModal } from './components/CiteModal';
import { Sentence } from './components/Sentence';
import { AccuracyDrawer } from './components/drawers/AccuracyDrawer';
import { FunnelDrawer } from './components/drawers/FunnelDrawer';
import { HardwareDrawer } from './components/drawers/HardwareDrawer';
import { HfImportDrawer, HfRefetch } from './components/drawers/HfImportDrawer';
import { ManualModelDrawer } from './components/drawers/ManualModelDrawer';
import { MyModelsDrawer, MyModelsSync } from './components/drawers/MyModelsDrawer';
import { SpeedDrawer } from './components/drawers/SpeedDrawer';
import { VerifyDrawer } from './components/drawers/VerifyDrawer';
import { WorkloadDrawer } from './components/drawers/WorkloadDrawer';
import { antdTheme, THEME_MODES, ThemeModeProvider, useDarkMode, useReducedMotion, useThemeMode, type ThemeMode } from './theme';

/** antd does not paint body: sync page background, text colour and color-scheme from the theme tokens. */
function PageTheme({ dark }: { dark: boolean }) {
  const { token } = theme.useToken();
  const lang = useLang();
  const tr = useT();
  useEffect(() => {
    const { body, documentElement } = document;
    body.style.background = token.colorBgLayout;
    body.style.color = token.colorText;
    documentElement.style.colorScheme = dark ? 'dark' : 'light';
    // CSS that cannot read antd tokens (the NCHC logo blend in web.css) keys off this.
    documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [token.colorBgLayout, token.colorText, dark]);
  useEffect(() => {
    document.documentElement.lang = lang;
    // The tab and bookmark title follow the language switch (index.html carries the zh-TW default for crawlers).
    document.title = tr('app.title');
  }, [lang, tr]);
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
      action={
        // The state that crashed lives in the URL: reload the page without its query (v8 minor 2).
        <Button size="small" icon={<ReloadOutlined />} onClick={() => window.location.assign(window.location.pathname)}>
          {tr('app.reset')}
        </Button>
      }
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

const THEME_ICON: Record<ThemeMode, ReactNode> = { system: <DesktopOutlined />, light: <SunOutlined />, dark: <MoonOutlined /> };

/** Appearance: follow the system, light or dark (design v10). The hover tip hides while the menu is open. */
function ThemeButton() {
  const tr = useT();
  const { mode, setMode } = useThemeMode();
  const [menu, setMenu] = useState(false);
  const [tip, setTip] = useState(false);
  const label = tr('theme.label', { mode: tr(`theme.${mode}`) });
  return (
    <Dropdown
      trigger={['click']}
      placement="bottomRight"
      open={menu}
      onOpenChange={(o) => {
        setMenu(o);
        if (o) setTip(false);
      }}
      menu={{
        selectable: true,
        selectedKeys: [mode],
        onClick: ({ key }) => setMode(key as ThemeMode),
        items: THEME_MODES.map((m) => ({ key: m, label: tr(`theme.${m}`), icon: THEME_ICON[m] })),
      }}
    >
      <Tooltip title={label} open={tip && !menu} onOpenChange={setTip}>
        <Button type="text" size="small" aria-label={label} icon={THEME_ICON[mode]} />
      </Tooltip>
    </Dropdown>
  );
}

/** Title | language, appearance and the GitHub repo (demo v10 header). */
function Header() {
  const tr = useT();
  const [{ lang }, dispatch] = useCalc();
  return (
    <Flex component="header" align="center" justify="space-between" gap={8} style={{ marginBottom: 8 }}>
      <Flex align="center" gap={8} style={{ minWidth: 0 }}>
        {/* The site icon (the favicon: GPU nodes, one partly filled), decorative next to the title. */}
        <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={22} height={22} style={{ flex: 'none' }} />
        <Typography.Title level={1} style={{ fontSize: 16, margin: 0, minWidth: 0 }}>
          {tr('app.title')}
        </Typography.Title>
      </Flex>
      <Flex align="center" gap={4} style={{ flex: 'none' }}>
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
        <ThemeButton />
        <Tooltip title={tr('header.github')}>
          <Button
            type="text"
            size="small"
            aria-label={tr('header.github')}
            icon={<GithubOutlined />}
            href={GITHUB_REPO}
            target="_blank"
            rel="noopener noreferrer"
          />
        </Tooltip>
      </Flex>
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
      <MyModelsDrawer />
      <MyModelsSync />
    </>
  );
}

function Shell() {
  return (
    <main style={{ maxWidth: 980, margin: '0 auto', padding: 16 }}>
      <Header />
      {/* demo v8: the sentence and answer in one card, the platform list in another */}
      <Card style={{ marginBottom: 12 }}>
        <Sentence />
        <AnswerLine />
      </Card>
      <Card styles={{ body: { padding: 12 } }}>
        <PlatformList />
      </Card>
      <CompareCard />
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
      <ThemeModeProvider>
        <ThemedApp />
      </ThemeModeProvider>
    </StoreProvider>
  );
}
