import React from 'react';
import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';

/**
 * Renders `tree` with Ink at a chosen terminal width. ink-testing-library
 * hardcodes its virtual stdout to 100 columns, so narrow-terminal behaviour
 * (truncation, wrapping) cannot be exercised through its render(). This
 * reimplements that render() (see node_modules/ink-testing-library) with a
 * configurable `columns`. Returns the latest frame accessor and an unmount.
 */
export function renderAtWidth(width: number, tree: React.ReactElement) {
  class Stdout extends EventEmitter {
    columns = width;
    frames: string[] = [];
    _lastFrame?: string;
    write = (frame: string) => { this.frames.push(frame); this._lastFrame = frame; };
    lastFrame = () => this._lastFrame;
  }
  class Stderr extends EventEmitter {
    frames: string[] = [];
    _lastFrame?: string;
    write = (frame: string) => { this.frames.push(frame); this._lastFrame = frame; };
    lastFrame = () => this._lastFrame;
  }
  class Stdin extends EventEmitter {
    isTTY = true;
    write = () => {};
    setEncoding = () => {};
    setRawMode = () => {};
    resume = () => {};
    pause = () => {};
    ref = () => {};
    unref = () => {};
    read = () => null;
  }
  const stdout = new Stdout();
  const instance = inkRender(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new Stderr() as unknown as NodeJS.WriteStream,
    stdin: new Stdin() as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return { lastFrame: stdout.lastFrame, unmount: instance.unmount };
}
