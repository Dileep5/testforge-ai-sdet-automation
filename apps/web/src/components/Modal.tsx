import { useEffect, useId, useRef, type ReactNode } from "react";
import { focusMainIfLost } from "../focus";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}

/** Built on <dialog>, so the browser provides the focus trap and Esc handling. */
export function Modal({ title, onClose, children, testId = "modal" }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement;
    if (dialog && !dialog.open) dialog.showModal();
    // The browser would pick the close button, which comes first. Start on the form instead.
    dialog?.querySelector<HTMLElement>("input, select, textarea")?.focus();
    return () => {
      dialog?.close();
      // By now React has removed the dialog, so the browser cannot restore focus by itself.
      if (opener instanceof HTMLElement) opener.focus();
      focusMainIfLost();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      data-testid={testId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="modal-header">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
