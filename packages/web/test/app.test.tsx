import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App, ErrorBoundary } from '../src/App';
import { renderStore } from './helpers';
import { getBundle } from '../src/bundle';
import { t } from '../src/i18n';
import { setMedia } from './setup';

describe('App', () => {
  it('renders the title, the language switch, no mode switch, and a data version from the bundle', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('國網推論算力計算機');
    expect(screen.getByText('中文')).toBeInTheDocument();
    expect(screen.getByText('English')).toBeInTheDocument();
    expect(screen.queryByText('我需要多少')).toBeNull();
    expect(screen.queryByText('我已有的能撐多少')).toBeNull();
    expect(screen.getByText(new RegExp(getBundle().meta.dataVersion))).toBeInTheDocument();
  });
  it('?lang=en switches UI copy', () => {
    history.replaceState(null, '', '/?lang=en');
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(t('en', 'app.title'));
  });
  it('the language switch changes the copy and the URL', async () => {
    render(<App />);
    await userEvent.click(screen.getByText('English'));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('NCHC Inference Calculator');
    expect(new URLSearchParams(location.search).get('lang')).toBe('en');
  });
});

function Boom(): never {
  throw new Error('boom');
}

describe('ErrorBoundary', () => {
  it('renders an alert instead of unmounting the page when a component throws (final review C1)', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderStore(
        <div>
          <span>still here</span>
          <ErrorBoundary>
            <Boom />
          </ErrorBoundary>
        </div>,
      );
      expect(screen.getByText('still here')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent(t('zh-TW', 'app.error'));
      expect(screen.getByRole('alert')).toHaveTextContent('boom');
    } finally {
      quiet.mockRestore();
    }
  });
});

describe('page theme', () => {
  it('body background and lang follow the color scheme and language', () => {
    setMedia({ dark: false });
    const light = render(<App />);
    const lightBg = document.body.style.background;
    expect(lightBg).not.toBe('');
    light.unmount();
    setMedia({ dark: true });
    render(<App />);
    expect(document.body.style.background).not.toBe(lightBg);
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.documentElement.lang).toBe('zh-TW');
  });
});
