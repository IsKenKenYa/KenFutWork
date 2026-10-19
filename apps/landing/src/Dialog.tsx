import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="dialog-title"
      onClose={onClose}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            event.currentTarget.close();
        }
      }}
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">KENFUTWORK</span>
          <h2 id="dialog-title">{title}</h2>
        </div>
        <button
          className="icon-button close-button"
          type="button"
          aria-label="关闭"
          onClick={() => ref.current?.close()}
        >
          <X size={22} strokeWidth={1.5} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
