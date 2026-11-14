// Chapter navigation and one default English caption track for the product tour.
(() => {
  const player = document.getElementById('product-tour');
  if (!player) return;
  const buttons = [...document.querySelectorAll('[data-video-seek]')];
  let pending = null;
  const seek = () => {
    if (pending === null || player.readyState < 1) return;
    player.currentTime = Math.max(0, Math.min(pending, Number.isFinite(player.duration) ? player.duration : pending));
    pending = null;
    player.play().catch(() => {});
  };
  player.addEventListener('loadedmetadata', () => {
    const preferred = player.querySelector('track[data-default-caption]')?.track;
    if (preferred) {
      for (const track of player.textTracks) if (track.kind === 'captions' || track.kind === 'subtitles') track.mode = 'disabled';
      preferred.mode = 'showing';
    }
    seek();
  }, { once: true });
  buttons.forEach(button => button.addEventListener('click', () => {
    const value = Number(button.dataset.videoSeek);
    if (!Number.isFinite(value) || value < 0) return;
    pending = value;
    if (player.readyState >= 1) seek(); else player.load();
    player.scrollIntoView({ block: 'nearest' });
  }));
  player.addEventListener('timeupdate', () => {
    let active = -1;
    buttons.forEach((button, index) => { if (Number(button.dataset.videoSeek) <= player.currentTime) active = index; });
    buttons.forEach((button, index) => {
      if (index === active) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    });
  });
})();
