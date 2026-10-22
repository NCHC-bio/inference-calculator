import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { getBundle } from '../src/bundle';
import { tZh } from '../src/i18n';
import { GITHUB_REPO, NCHC_ISERVICE } from '../src/reportModel';
import { defaultState } from '../src/state/state';
import { THEME_MODE_KEY } from '../src/theme';
import { setMedia } from './setup';

const theme = () => document.documentElement.dataset.theme;
const themeButton = () => screen.getByRole('button', { name: /外觀/ });

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('header (design v10)', () => {
  it('appearance follows the system by default, live', async () => {
    render(<App />);
    expect(themeButton()).toHaveAccessibleName(tZh('theme.label', { mode: tZh('theme.system') }));
    expect(theme()).toBe('light');
    setMedia({ dark: true });
    await waitFor(() => expect(theme()).toBe('dark'));
  });
  it('picking dark overrides a light system, is stored, survives a reload and stays out of the URL', async () => {
    const first = render(<App />);
    await userEvent.click(themeButton());
    await userEvent.click(await screen.findByRole('menuitem', { name: new RegExp(tZh('theme.dark')) }));
    await waitFor(() => expect(theme()).toBe('dark'));
    expect(localStorage.getItem(THEME_MODE_KEY)).toBe('dark');
    expect(location.search).not.toMatch(/theme/);
    first.unmount();
    render(<App />);
    expect(theme()).toBe('dark');
    expect(themeButton()).toHaveAccessibleName(tZh('theme.label', { mode: tZh('theme.dark') }));
  });
  it('picking system again clears the stored choice', async () => {
    localStorage.setItem(THEME_MODE_KEY, 'light');
    setMedia({ dark: true });
    render(<App />);
    expect(theme()).toBe('light');
    await userEvent.click(themeButton());
    await userEvent.click(await screen.findByRole('menuitem', { name: new RegExp(tZh('theme.system')) }));
    await waitFor(() => expect(theme()).toBe('dark'));
    expect(localStorage.getItem(THEME_MODE_KEY)).toBeNull();
  });
  it('blocked storage falls back to the system and still switches for the page', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<App />);
    expect(theme()).toBe('light');
    await userEvent.click(themeButton());
    await userEvent.click(await screen.findByRole('menuitem', { name: new RegExp(tZh('theme.dark')) }));
    await waitFor(() => expect(theme()).toBe('dark'));
  });
  it('shows the site icon beside the title and links the GitHub repo in a new tab', () => {
    render(<App />);
    const icon = document.querySelector('header img')!;
    expect(icon).toHaveAttribute('src', expect.stringMatching(/favicon\.svg$/));
    expect(icon).toHaveAttribute('alt', '');
    const gh = screen.getByRole('link', { name: tZh('header.github') });
    expect(gh).toHaveAttribute('href', GITHUB_REPO);
    expect(gh).toHaveAttribute('target', '_blank');
  });
});

describe('footer (design v10)', () => {
  it('NCHC logo and name link to iService; GitHub and report links; the notes stay', () => {
    render(<App />);
    const footer = document.querySelector('footer')!;
    const nchc = within(footer).getByRole('link', { name: new RegExp(tZh('footer.nchc')) });
    expect(nchc).toHaveAttribute('href', NCHC_ISERVICE);
    expect(within(nchc).getByRole('img', { name: 'NCHC' })).toHaveAttribute('src', expect.stringMatching(/nchc-logo\.png$/));
    expect(within(footer).getByRole('link', { name: new RegExp(tZh('footer.github')) })).toHaveAttribute('href', GITHUB_REPO);
    expect(within(footer).getByRole('link', { name: new RegExp(tZh('footer.report')) })).toHaveAttribute('href', `${GITHUB_REPO}/issues/new/choose`);
    expect(within(footer).getByText(tZh('footer.dataVersion', { version: getBundle().meta.dataVersion }))).toBeInTheDocument();
    expect(within(footer).getByRole('button', { name: tZh('footer.accuracy') })).toBeInTheDocument();
  });
});

describe('report a number (design v10)', () => {
  it('the basis modal links a new issue titled with the model and carrying the page URL', async () => {
    const b = getBundle();
    const model = b.models[defaultState(b).model]!.name;
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: /依據/ }));
    const link = await screen.findByRole('link', { name: new RegExp(tZh('basis.report.link').replace(/[()（）]/g, '.')) });
    const url = new URL(link.getAttribute('href')!);
    expect(`${url.origin}${url.pathname}`).toBe(`${GITHUB_REPO}/issues/new`);
    expect(url.searchParams.get('title')).toBe(tZh('basis.report.title', { model }));
    expect(url.searchParams.get('body')).toContain(location.href);
  });
});
