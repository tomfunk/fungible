import { isPersistent } from '../../core/db.browser.js';

/** false when this browser could not give the app durable storage (in-memory fallback). */
export function isDbPersistent(): boolean {
  return isPersistent();
}
