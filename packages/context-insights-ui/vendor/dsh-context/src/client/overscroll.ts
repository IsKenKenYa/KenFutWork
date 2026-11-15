export function containHorizontalOverscroll(el: HTMLElement): () => void {
  const onWheel = (e: WheelEvent): void => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    const atStart = e.deltaX < 0 && el.scrollLeft <= 0
    const atEnd = e.deltaX > 0 && el.scrollLeft + el.clientWidth >= el.scrollWidth - 1
    if (atStart || atEnd) e.preventDefault()
  }
  el.addEventListener('wheel', onWheel, { passive: false })
  return () => { el.removeEventListener('wheel', onWheel) }
}
