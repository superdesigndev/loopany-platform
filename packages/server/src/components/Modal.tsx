import { Dialog } from '@base-ui/react/dialog'
import type { ReactNode } from 'react'
import { sectionHeadCls } from './ui'

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
        {/* Depth-of-field scrim: a light dim + real backdrop blur, so the page
            recedes behind the glass instead of going black. */}
        <Dialog.Backdrop className="fixed inset-0 z-[900] bg-black/25 backdrop-blur-[8px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 dark:bg-black/45" />
        <Dialog.Popup
          className={`glass-strong fixed left-1/2 z-[901] w-full -translate-x-1/2 overflow-auto rounded-sheet px-[26px] pb-7 pt-6 outline-none transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 ${pos}`}
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
        <Dialog.Title className="text-[20px] font-semibold tracking-[-0.015em] text-display">
          {title}
        </Dialog.Title>
        <Dialog.Close
          aria-label="Close"
          className="-mr-1 shrink-0 cursor-pointer rounded-full border-none bg-transparent px-1.5 py-0.5 text-[15px] leading-none text-disabled transition-colors hover:text-display focus-visible:text-display focus-visible:outline-none"
        >
          ✕
        </Dialog.Close>
      </div>
      {sub != null && <div className="mt-1.5 text-meta text-secondary">{sub}</div>}
    </>
  )
}

/**
 * Section divider heading - sentence case, hierarchy from weight + color.
 * `action` drops an optional control (e.g. Copy) flush-right on the divider.
 */
export function ModalSection({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2.5 mt-6 flex items-end justify-between gap-3 border-b border-hairline pb-1.5">
      <h2 className={sectionHeadCls}>{children}</h2>
      {action}
    </div>
  )
}
