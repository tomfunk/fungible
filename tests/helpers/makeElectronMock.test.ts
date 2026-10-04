import { beforeEach, describe, expect, it, vi } from 'vitest';
import { electronMock, makeEvent, makeWindow } from './makeElectronMock.js';

vi.mock('electron', async () => (await import('./makeElectronMock.js')).electronModule());

beforeEach(() => electronMock.reset());

describe('makeElectronMock', () => {
  it('registers ipc handlers and invokes them with a fake event', async () => {
    const { ipcMain } = await import('electron');
    ipcMain.handle('x', (e: any, a: number) => [e.sender.isDestroyed(), a]);
    expect(await electronMock.invoke('x', 3)).toEqual([false, 3]);
    expect(await electronMock.invokeWith(makeEvent({ destroyed: true }), 'x', 1)).toEqual([true, 1]);
    ipcMain.removeHandler('x');
    await expect(electronMock.invoke('x')).rejects.toThrow(/No ipcMain handler/);
  });

  it('tracks windows and drops them on closed', async () => {
    const { BrowserWindow } = await import('electron');
    const w = new BrowserWindow({ title: 't' }) as any;
    expect(BrowserWindow.getAllWindows()).toHaveLength(1);
    expect(w.options.title).toBe('t');
    makeWindow();
    expect(electronMock.windows).toHaveLength(2);
    w.emit('closed');
    expect(electronMock.windows).toHaveLength(1);
  });

  it('reset clears handlers and windows', async () => {
    const { ipcMain } = await import('electron');
    ipcMain.handle('y', () => 1);
    makeWindow();
    electronMock.reset();
    expect(electronMock.handlers.size).toBe(0);
    expect(electronMock.windows).toHaveLength(0);
  });

  it('whenReady resolves only after flushReady', async () => {
    const { app } = await import('electron');
    const cb = vi.fn();
    app.whenReady().then(cb);
    await Promise.resolve();
    expect(cb).not.toHaveBeenCalled();
    await electronMock.app.flushReady();
    expect(cb).toHaveBeenCalled();
  });

  it('net.request delivers multibyte bodies split across chunks', async () => {
    const { net } = await import('electron');
    const req = net.request({ url: 'u' }) as any;
    let body = '';
    const chunks: Buffer[] = [];
    req.on('response', (res: any) => {
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => (body = Buffer.concat(chunks).toString('utf8')));
    });
    req.setHeader('A', 'b');
    req.end();
    req.respond(200, '{"t":"héllo✓"}', 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((c) => c.toString('utf8').includes('�'))).toBe(true);
    expect(body).toBe('{"t":"héllo✓"}');
    expect(req.headers).toEqual({ A: 'b' });
    expect(req.ended).toBe(true);
  });

  it('Menu.buildFromTemplate returns the template', async () => {
    const { Menu } = await import('electron');
    const t = [{ label: 'a' }];
    expect(Menu.buildFromTemplate(t as any)).toBe(t);
  });

  it('works for a real gui/main module (refresh-ipc pushes to every window)', async () => {
    const { registerRefreshPush } = await import('../../gui/main/refresh-ipc.js');
    const { notifyChange } = await import('../../core/refresh.js');
    const a = makeWindow();
    const b = makeWindow();
    registerRefreshPush();
    notifyChange();
    expect(a.webContents.send).toHaveBeenCalledWith('refresh');
    expect(b.webContents.send).toHaveBeenCalledWith('refresh');
  });
});

describe('makeElectronMock resetModules safety', () => {
  it('a re-evaluated copy of the helper shares the same singleton', async () => {
    vi.resetModules();
    const fresh = await import('./makeElectronMock.js');
    expect(fresh.electronMock).toBe(electronMock);
    const { BrowserWindow } = await import('electron');
    makeWindow();
    expect(BrowserWindow.getAllWindows()).toHaveLength(1);
    new BrowserWindow();
    expect(electronMock.windows).toHaveLength(2);
  });
});
