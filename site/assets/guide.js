// Documentation-only reading controls; ordinary image and anchor links work without JS.
(() => {
  // The page declares the required stylesheet version for returning readers.
  const sheet = document.querySelector('link[rel="stylesheet"]');
  const version = document.body.dataset.stylesheetVersion;
  if (sheet && version) {
    const url = new URL(sheet.href); url.searchParams.set('v', version);
    if (sheet.href !== url.href) sheet.href = url.href;
  }
  const language = document.documentElement.lang;
  const dictionaries = {"en": {"close": "Close", "zoom": "Original size", "fit": "Fit to screen", "hint": "Image detail"}, "ko": {"close": "닫기", "zoom": "원본 크기", "fit": "화면에 맞추기", "hint": "이미지 세부 정보"}, "ja": {"close": "閉じる", "zoom": "原寸大", "fit": "画面に合わせる", "hint": "画像の詳細"}, "zh-CN": {"close": "关闭", "zoom": "原始尺寸", "fit": "适合屏幕", "hint": "图片详细信息"}, "es": {"close": "Cerrar", "zoom": "Tamaño original", "fit": "Ajustar a la pantalla", "hint": "Detalles de la imagen"}};
  const labels = dictionaries[language] || dictionaries.en;
  const links = [...document.querySelectorAll('a[data-lightbox]')];
  if (links.length && typeof HTMLDialogElement !== 'undefined') {
    const dialog = document.createElement('dialog');
    dialog.className = 'image-viewer'; dialog.setAttribute('aria-label', labels.hint);
    const bar = document.createElement('div'); bar.className = 'image-viewer-toolbar';
    const caption = document.createElement('p');
    const actions = document.createElement('div');
    const zoom = document.createElement('button'); zoom.type = 'button'; zoom.textContent = labels.zoom;
    const close = document.createElement('button'); close.type = 'button'; close.textContent = labels.close;
    actions.append(zoom, close); bar.append(caption, actions);
    const canvas = document.createElement('div'); canvas.className = 'image-viewer-canvas';
    const image = document.createElement('img'); canvas.append(image); dialog.append(bar, canvas); document.body.append(dialog);
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
    zoom.addEventListener('click', () => {
      const enlarged = dialog.dataset.zoomed !== 'true'; dialog.dataset.zoomed = String(enlarged);
      zoom.textContent = enlarged ? labels.fit : labels.zoom;
    });
    links.forEach(link => link.addEventListener('click', e => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault(); const thumb = link.querySelector('img');
      image.src = link.href; image.alt = thumb?.alt || labels.hint; caption.textContent = image.alt;
      dialog.dataset.zoomed = 'false'; zoom.textContent = labels.zoom; dialog.showModal();
    }));
  }
  const toc = document.querySelector('.manual-nav');
  if (toc && window.matchMedia('(max-width: 850px)').matches) toc.open = false;
  document.querySelectorAll('a[href^="#"]').forEach(link => link.addEventListener('click', () => {
    const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
    for (let node = target; node; node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true;
  }));
  if ('IntersectionObserver' in window && toc) {
    const anchors = [...toc.querySelectorAll('a[href^="#"]')];
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        anchors.forEach(a => a.removeAttribute('aria-current'));
        anchors.find(a => a.hash === `#${entry.target.id}`)?.setAttribute('aria-current', 'true');
      }
    }, { rootMargin: '-15% 0px -65% 0px', threshold: 0 });
    document.querySelectorAll('.manual-body > section[id]').forEach(section => observer.observe(section));
  }
})();
