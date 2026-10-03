import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Modal } from './Modal.js';
import type { BalanceImportPreview, BalanceImportResult } from '../../../../core/balance-import.js';
import { BALANCE_IMPORT_SKIP_COPY, summarizeSkips } from '../../../../core/balance-import-copy.js';
import styles from '../screens/Accounts.module.css';

export const SKIPPED_LIST_CAP = 20;
const FORMAT_HELP =
  'date (YYYY-MM-DD), account name, balance. For credit cards and loans, enter the amount owed as a positive number.';

export function BalanceHistoryImportModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (result: BalanceImportResult) => void;
}) {
  const [file, setFile] = useState<{ fileName: string; text: string } | null>(null);
  const [preview, setPreview] = useState<BalanceImportPreview | null>(null);
  const [accountMap, setAccountMap] = useState<Record<string, string | null>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const closed = useRef(false);

  async function runPreview(text: string, map: Record<string, string | null>) {
    try {
      setPreview(await api.balanceImport.previewBalanceImport(text, { accountMap: map }));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that file');
    }
  }

  async function pick() {
    try {
      const picked = await api.files.pickText();
      if (!picked) {
        // Cancelling the very first pick closes; later re-picks just keep the modal.
        if (!file && !closed.current) onClose();
        return;
      }
      setFile({ fileName: picked.fileName, text: picked.text });
      setAccountMap({});
      setPreview(null);
      await runPreview(picked.text, {});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that file');
    }
  }

  useEffect(() => {
    void pick();
    return () => { closed.current = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function mapAccount(name: string, value: string) {
    if (!file) return;
    const next = { ...accountMap, [name]: value === '' ? null : value };
    setAccountMap(next);
    await runPreview(file.text, next);
  }

  async function commit() {
    if (!file || !preview || preview.valid === 0 || busy) return;
    setBusy(true);
    try {
      const result = await api.balanceImport.commitBalanceImport(file.text, { accountMap });
      onDone(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
      setBusy(false);
    }
  }

  const needsMapping = preview ? [...preview.unmatched.map((u) => u.name), ...preview.ambiguous.map((a) => a.name)] : [];
  const select = (name: string, options: { id: string; name: string }[]) => (
    <select value={accountMap[name] ?? ''} onChange={(e) => void mapAccount(name, e.target.value)}>
      <option value="">Skip</option>
      {options.map((a) => (
        <option key={a.id} value={a.id}>{a.name}</option>
      ))}
    </select>
  );

  return (
    <Modal title="Import balance history" onClose={onClose}>
      {!preview ? (
        <div>
          <p className="dim">{file ? 'Reading file…' : 'Choose a file to import.'}</p>
          <p className="dim">{FORMAT_HELP}</p>
          {error && <p className="neg">{error}</p>}
          <div className="modalActions">
            <button className="btnSecondary" onClick={onClose}>Cancel</button>
            <button className="btnPrimary" onClick={() => void pick()}>Choose file…</button>
          </div>
        </div>
      ) : (
        <div>
          <p className="dim">{file?.fileName} · {preview.totalRows} rows</p>
          <p>
            {preview.willInsert} balances will be added, {preview.willOverwrite.count} will replace existing values,{' '}
            {preview.skipped.length} skipped
            {preview.skipped.length > 0 && ` (${summarizeSkips(preview.skipped)})`}
          </p>
          {preview.warnings.map((w, i) => (
            <p key={i} className="dim">{w}</p>
          ))}

          {preview.overwriteSample.length > 0 && (
            <>
              <h3 className="sectionLabel">Replacing</h3>
              <table className={styles.table}>
                <tbody>
                  {preview.overwriteSample.map((o, i) => (
                    <tr key={i}>
                      <td>{o.accountName}</td>
                      <td className="dim">{o.date}</td>
                      <td className="num">{o.oldBalance.toFixed(2)} → {o.newBalance.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {needsMapping.length > 0 && (
            <>
              <h3 className="sectionLabel">Unmatched accounts</h3>
              <table className={styles.table}>
                <tbody>
                  {preview.unmatched.map((u) => (
                    <tr key={`u-${u.name}`}>
                      <td>{u.name} <span className="dim">({u.rows} rows)</span></td>
                      <td>{select(u.name, preview.accounts)}</td>
                    </tr>
                  ))}
                  {preview.ambiguous.map((a) => (
                    <tr key={`a-${a.name}`}>
                      <td>{a.name} <span className="dim">(ambiguous)</span></td>
                      <td>{select(a.name, a.candidates)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {preview.skipped.length > 0 && (
            <>
              <h3 className="sectionLabel">Skipped rows</h3>
              <ul className="dim">
                {preview.skipped.slice(0, SKIPPED_LIST_CAP).map((s) => (
                  <li key={s.line}>Line {s.line}: {BALANCE_IMPORT_SKIP_COPY[s.reason]}</li>
                ))}
                {preview.skipped.length > SKIPPED_LIST_CAP && (
                  <li>…and {preview.skipped.length - SKIPPED_LIST_CAP} more</li>
                )}
              </ul>
            </>
          )}

          <p className="dim">{FORMAT_HELP}</p>
          {error && <p className="neg">{error}</p>}
          <div className="modalActions">
            <button className="btnSecondary" onClick={onClose}>Cancel</button>
            <button className="btnPrimary" onClick={() => void commit()} disabled={preview.valid === 0 || busy}>
              {busy ? 'Importing…' : 'Import'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
