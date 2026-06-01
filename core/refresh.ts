import { EventEmitter } from 'node:events';

const emitter = new EventEmitter();

export function notifyChange(): void {
  emitter.emit('change');
}

export function onRefresh(fn: () => void): () => void {
  emitter.on('change', fn);
  return () => { emitter.off('change', fn); };
}
