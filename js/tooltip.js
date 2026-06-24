/**
 * A single reusable floating tooltip, styled like NorthStar's panels.
 * Appears instantly on hover (no delay), follows the cursor, clamps to viewport.
 * Pass HTML (string or a function returning a string) for rich content.
 */
let tip;

function ensure() {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tooltip';
    tip.setAttribute('role', 'tooltip');
    tip.style.display = 'none';
    document.body.appendChild(tip);
  }
  return tip;
}

function place(e) {
  const t = ensure();
  const pad = 14;
  const r = t.getBoundingClientRect();
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
  t.style.left = `${Math.max(8, x)}px`;
  t.style.top = `${Math.max(8, y)}px`;
}

function hide() {
  if (tip) tip.style.display = 'none';
}

/** Attach a rich tooltip to an element. `content` is HTML or () => HTML. */
export function attachTooltip(target, content) {
  target.addEventListener('mouseenter', e => {
    const t = ensure();
    t.innerHTML = typeof content === 'function' ? content() : content;
    t.style.display = 'block';
    place(e);
  });
  target.addEventListener('mousemove', place);
  target.addEventListener('mouseleave', hide);
}
