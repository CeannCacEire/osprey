(() => {
  const guide = document.querySelector('.island-guide a');
  if (!guide) return;
  const map = guide.querySelector('.guide-map');
  const motion = matchMedia('(hover:hover) and (pointer:fine) and (prefers-reduced-motion:no-preference)');
  function clear() {
    guide.classList.remove('is-pointing');
    guide.style.removeProperty('--point-angle');
  }
  map.addEventListener('pointermove', event => {
    if (!motion.matches || event.pointerType === 'touch') return;
    const rect = map.getBoundingClientRect();
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    guide.style.setProperty('--point-angle', `${3 - 5 * y}deg`);
    guide.classList.add('is-pointing');
  });
  map.addEventListener('pointerleave', clear);
  motion.addEventListener('change', clear);
})();
