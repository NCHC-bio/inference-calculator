import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
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
