/**
 * Add a dismiss control to the modal. The stock header (and its close button)
 * is hidden by the stylesheet in favour of the injected brand header, so when
 * the login is shown *over* the app — "add another account" — we drop in our
 * own floating close so the user can back out without signing in. Returns a
 * detacher; a no-op when there is no modal to attach to.
 */
export function addCancelAffordance(el: HTMLElement, onCancel: () => void): () => void {
  const modal = el.querySelector<HTMLElement>('.nostr-signer__modal')
  if (!modal) return () => {}
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'nostr-signer__cancel-fab'
  btn.setAttribute('aria-label', 'Cancel')
  btn.innerHTML = '&times;'
  btn.addEventListener('click', onCancel)
  modal.appendChild(btn)
  return () => btn.remove()
}
