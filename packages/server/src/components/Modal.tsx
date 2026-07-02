import { Dialog } from '@base-ui/react/dialog'
import type { ReactNode } from 'react'

/** Shared modal shell — Base UI Dialog handles focus trap, Esc, scroll lock.
 *  Content-height, optically centered — sized for the small form/compose dialogs
 *  (the old `detail`/`wide` variants died with the modal-era job/run views). */
export function Modal({
  open,
  onClose,
  children,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
}) {
  const pos = 'top-[46%] -translate-y-1/2 max-w-160 max-h-[calc(100dvh-5rem)]'
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[900] bg-black/80 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          className={`fixed left-1/2 z-[901] w-full -translate-x-1/2 overflow-auto rounded-2xl border border-wire bg-surface px-[26px] pb-7 pt-6 outline-none transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 ${pos}`}
        >
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function ModalHead({ title, sub }: { title: string; sub?: ReactNode }) {
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <Dialog.Title className="text-[22px] font-medium tracking-tight text-display">
          {title}
        </Dialog.Title>
        <Dialog.Close className="-mr-1 shrink-0 cursor-pointer rounded-md border-none bg-transparent px-1 font-mono text-[13px] leading-none tracking-widest text-disabled transition-colors hover:text-display focus-visible:text-display focus-visible:outline-none">
          [ X ]
        </Dialog.Close>
      </div>
      {sub != null && (
        <div className="mt-1.5 font-mono text-[12px] tracking-[0.02em] text-secondary">{sub}</div>
      )}
    </>
  )
}

/**
 * Section label — Space Mono ALL CAPS instrument-panel divider heading.
 * `action` drops an optional control (e.g. Copy) flush-right on the divider.
 */
export function ModalSection({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2.5 mt-6 flex items-end justify-between gap-3 border-b border-hairline pb-1.5">
      <h2 className="font-mono text-[11px] tracking-[0.08em] text-secondary">{children}</h2>
      {action}
    </div>
  )
}
