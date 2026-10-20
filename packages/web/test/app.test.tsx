import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App, ErrorBoundary } from '../src/App';
import { renderStore } from './helpers';
import { getBundle } from '../src/bundle';
import { t } from '../src/i18n';
import { setMedia } from './setup';

describe('App', () => {
  it('renders the mode switch and a data version from the bundle', () => {
    render(<App />);
    expect(screen.getByText('我需要多少')).toBeInTheDocument();
    expect(screen.getByText('我已有的能撐多少')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(getBundle().meta.dataVersion))).toBeInTheDocument();
  });
  it('?lang=en switches UI copy', () => {
    history.replaceState(null, '', '/?lang=en');
    render(<App />);
    expect(screen.getByText(t('en', 'mode.need'))).toBeInTheDocument();
    expect(t('en', 'mode.need')).toBe('How much do I need');
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
