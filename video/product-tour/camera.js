/* Adapted from HyperFrames registry ui-focus-zoom: one world transform,
   translate(x, y) scale(s), with T = -offset * s and a bounded pan.
   Real captures replace the registry's skeleton slot; no drift or halo. */
window.tourCamera = function (timeline, world, config) {
  const {width, height, viewportWidth, viewportHeight} = config;
  function pose(roi) {
    const [x, y, w, h] = roi;
    const scale = Math.min(viewportWidth / w, viewportHeight / h);
    const limitX = Math.max(0, (width * scale - viewportWidth) / 2);
    const limitY = Math.max(0, (height * scale - viewportHeight) / 2);
    const clamp = (v, limit) => Math.max(-limit, Math.min(limit, v));
    return {scale, x: clamp(-(x + w / 2 - width / 2) * scale, limitX),
      y: clamp(-(y + h / 2 - height / 2) * scale, limitY)};
  }
  const start = pose(config.roi);
  timeline.set(world, start, 0);
  if (config.focus) timeline.fromTo(world, start, {...pose(config.focus),
    duration: 1.25, ease: 'power2.inOut', immediateRender: false}, config.at ?? 2.5);
};
