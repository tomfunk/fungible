import { useState } from 'react';
import { Modal } from './Modal.js';
import styles from './NameModal.module.css';

/**
 * Single-text-field add/rename modal — Enter or the Save button commits,
 * disabled while blank. Shared by Rules (categories) and Tags (tag names),
 * which were carrying byte-identical copies save for the input placeholder.
 */
export function NameModal({
  title,
  initial,
  placeholder,
  onClose,
  onSave,
}: {
  title: React.ReactNode;
  initial: string;
  placeholder: string;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  return (
    <Modal title={title} onClose={onClose}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim()) onSave(name.trim());
        }}
        placeholder={placeholder}
        autoFocus
        className={styles.modalInput}
      />
      <div className="modalActions">
        <button className="btnSecondary" onClick={onClose}>
          Cancel
        </button>
        <button className="btnPrimary" onClick={() => name.trim() && onSave(name.trim())} disabled={!name.trim()}>
          Save
        </button>
      </div>
    </Modal>
  );
}
