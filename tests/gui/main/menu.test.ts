import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { electronMock } from '../../helpers/makeElectronMock.js';

vi.mock('electron', async () => (await import('../../helpers/makeElectronMock.js')).electronModule());

import { buildMenu } from '../../../gui/main/menu.js';

type Item = { label?: string; role?: string; type?: string; click?: () => unknown; submenu?: Item[] };

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const savedEnv = { ...process.env };
const savedArgv = [...process.argv];
const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p });

function build(platform: 'darwin' | 'linux', demo = false): Item[] {
  setPlatform(platform);
  if (demo) process.env.FUNGIBLE_DEMO = '1'; else delete process.env.FUNGIBLE_DEMO;
  buildMenu();
  return vi.mocked(electronMock.Menu.buildFromTemplate).mock.results.at(-1)!.value as Item[];
}
const find = (items: Item[] | undefined, label: string) => items!.find((i) => i.label === label)!;
const help = (t: Item[]) => t.find((i) => i.role === 'help')!.submenu!;

beforeEach(() => {
  electronMock.reset();
  electronMock.Menu.buildFromTemplate.mockClear();
});
afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  process.argv = [...savedArgv];
  for (const k of ['FUNGIBLE_DEMO', 'FUNGIBLE_DATA_DIR']) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

describe('menu structure', () => {
  it('darwin: app menu first with About / Check for Updates / Demo / Quit', () => {
    const t = build('darwin');
    expect(t[0].label).toBe('fungible');
    const sub = t[0].submenu!;
    expect(sub[0]).toEqual({ role: 'about' });
    expect(find(sub, 'Check for Updates…')).toBeDefined();
    expect(find(sub, 'Try Demo Mode')).toBeDefined();
    expect(sub.at(-1)).toEqual({ role: 'quit' });
    expect(t.slice(1).map((i) => i.role)).toEqual(['editMenu', 'viewMenu', 'windowMenu', 'help']);
    // on mac the updates/demo items live in the app menu, not Help
    expect(help(t).map((i) => i.label)).toEqual(['GitHub Repository']);
  });

  it('non-darwin: no app menu; Help holds updates, demo, separator, GitHub', () => {
    const t = build('linux');
    expect(t.map((i) => i.role)).toEqual(['editMenu', 'viewMenu', 'windowMenu', 'help']);
    const h = help(t);
    expect(h.map((i) => i.label ?? i.type)).toEqual(['Check for Updates…', 'Try Demo Mode', 'separator', 'GitHub Repository']);
  });

  it('sets the application menu exactly once from the built template', () => {
    build('linux');
    expect(electronMock.Menu.setApplicationMenu).toHaveBeenCalledTimes(1);
  });

  it('demo label flips with FUNGIBLE_DEMO', () => {
    expect(help(build('linux', false)).some((i) => i.label === 'Try Demo Mode')).toBe(true);
    const h = help(build('linux', true));
    expect(h.some((i) => i.label === 'Leave Demo Mode')).toBe(true);
    expect(h.some((i) => i.label === 'Try Demo Mode')).toBe(false);
  });

  it('GitHub item opens the repo', () => {
    find(help(build('linux')), 'GitHub Repository').click!();
    expect(electronMock.shell.openExternal).toHaveBeenCalledExactlyOnceWith('https://github.com/tomfunk/fungible');
  });
});

describe('demo relaunch', () => {
  it('entering demo: --demo is added exactly once and the app quits', () => {
    process.argv = ['electron', '.', '--foo', '--demo'];
    find(help(build('linux')), 'Try Demo Mode').click!();
    const { args } = electronMock.app.relaunch.mock.calls[0][0];
    expect(args).toEqual(['.', '--foo', '--demo']);
    expect(args.filter((a: string) => a === '--demo')).toHaveLength(1);
    expect(electronMock.app.quit).toHaveBeenCalledTimes(1);
  });

  it('entering demo does not touch the data-dir env', () => {
    process.env.FUNGIBLE_DATA_DIR = '/somewhere';
    find(help(build('linux')), 'Try Demo Mode').click!();
    expect(process.env.FUNGIBLE_DATA_DIR).toBe('/somewhere');
  });

  it('leaving demo: strips --demo and clears FUNGIBLE_DEMO and FUNGIBLE_DATA_DIR so the child opens the real DB', () => {
    process.argv = ['electron', '.', '--demo', '--bar'];
    process.env.FUNGIBLE_DATA_DIR = '/tmp/demo-data';
    const item = find(help(build('linux', true)), 'Leave Demo Mode');
    item.click!();
    expect(electronMock.app.relaunch).toHaveBeenCalledExactlyOnceWith({ args: ['.', '--bar'] });
    expect(process.env.FUNGIBLE_DEMO).toBeUndefined();
    expect(process.env.FUNGIBLE_DATA_DIR).toBeUndefined();
    expect(electronMock.app.quit).toHaveBeenCalledTimes(1);
  });
});

describe('check for updates', () => {
  async function check(current: string, respond: (r: (typeof electronMock.requests)[number]) => void) {
    electronMock.app.getVersion.mockImplementation(() => current);
    const click = find(help(build('linux')), 'Check for Updates…').click!;
    const done = click();
    respond(electronMock.requests[0]);
    await done;
    return electronMock.dialog.showMessageBox.mock.calls[0]?.[0] as any;
  }
  const release = (tag: string) => (r: any) => r.respond(200, JSON.stringify({ tag_name: tag }));

  it('requests the latest-release API with GitHub-required headers', async () => {
    await check('1.9.1', release('v1.9.1'));
    const req = electronMock.requests[0];
    expect(req.opts).toEqual({ method: 'GET', url: 'https://api.github.com/repos/tomfunk/fungible/releases/latest' });
    expect(req.headers['User-Agent']).toBe('fungible/1.9.1');
    expect(req.headers.Accept).toBe('application/vnd.github+json');
    expect(req.ended).toBe(true);
  });

  it('newer release: offers Download/Later; Download opens the releases page', async () => {
    electronMock.dialog.showMessageBox.mockImplementation(async () => ({ response: 0 }));
    const d = await check('1.9.1', release('v2.0.0'));
    expect(d).toMatchObject({ title: 'Update available', buttons: ['Download', 'Later'] });
    expect(d.detail).toBe("You're on v1.9.1. Latest is v2.0.0.");
    expect(electronMock.shell.openExternal).toHaveBeenCalledExactlyOnceWith('https://github.com/tomfunk/fungible/releases/latest');
  });

  it('Later does not open anything', async () => {
    electronMock.dialog.showMessageBox.mockImplementation(async () => ({ response: 1 }));
    await check('1.9.1', release('v2.0.0'));
    expect(electronMock.shell.openExternal).not.toHaveBeenCalled();
  });

  it.each([
    ['same version', '1.9.1', 'v1.9.1'],
    ['older release', '1.9.1', 'v1.9.0'],
    ['older major', '2.0.0', 'v1.99.99'],
    ['prerelease suffix ignored', '1.2.3-beta', 'v1.2.3'],
  ])('%s -> No updates', async (_n, current, tag) => {
    const d = await check(current, release(tag));
    expect(d).toMatchObject({ title: 'No updates', buttons: ['OK'] });
    expect(d.message).toContain(`v${current}`);
    expect(electronMock.shell.openExternal).not.toHaveBeenCalled();
  });

  it.each([
    ['numeric not lexical: 1.10.0 > 1.9.1', '1.9.1', 'v1.10.0'],
    ['patch bump', '1.9.1', 'v1.9.2'],
    ['major dominates', '1.99.99', 'v2.0.0'],
  ])('%s -> Update available', async (_n, current, tag) => {
    const d = await check(current, release(tag));
    expect(d.title).toBe('Update available');
  });

  // SMELL S1: the menu uses the raw app.getVersion(). With the dev/placeholder
  // version the dialog reads "You're on v0.0.0-nobumpnecessary" and ANY release
  // counts as an update. Pinned as current behaviour.
  it('pins placeholder version: shown verbatim and always offers an update', async () => {
    const d = await check('0.0.0-nobumpnecessary', release('v0.0.1'));
    expect(d.title).toBe('Update available');
    expect(d.detail).toBe("You're on v0.0.0-nobumpnecessary. Latest is v0.0.1.");
  });

  it('non-200 -> failure dialog naming the status', async () => {
    const d = await check('1.0.0', (r) => r.respond(404, 'nope'));
    expect(d).toMatchObject({ type: 'error', title: 'Update check failed' });
    expect(d.detail).toContain('GitHub API returned 404');
  });

  it.each([
    ['missing tag_name', '{"name":"x"}'],
    ['empty tag_name', '{"tag_name":""}'],
  ])('%s -> No releases found', async (_n, body) => {
    const d = await check('1.0.0', (r) => r.respond(200, body));
    expect(d).toMatchObject({ type: 'error', title: 'Update check failed' });
    expect(d.detail).toBe('No releases found');
  });

  it('invalid JSON -> error dialog (parse error surfaced)', async () => {
    const d = await check('1.0.0', (r) => r.respond(200, '<html>'));
    expect(d).toMatchObject({ type: 'error', title: 'Update check failed' });
    expect(d.detail).toMatch(/JSON/);
  });

  it('request-level error -> error dialog with the message', async () => {
    const d = await check('1.0.0', (r) => r.fail(new Error('ENOTFOUND api.github.com')));
    expect(d).toMatchObject({ type: 'error', title: 'Update check failed' });
    expect(d.detail).toBe('ENOTFOUND api.github.com');
  });

  it('decodes multibyte UTF-8 split across chunk boundaries', async () => {
    // The tag survives only if bytes are buffered and decoded once.
    const tag = 'v2.0.0-ünï€😀';
    const d = await check('1.0.0', (r) => r.respond(200, JSON.stringify({ tag_name: tag }), 11));
    expect(d.title).toBe('Update available');
    expect(d.detail).toContain(tag);
  });
});
