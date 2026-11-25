'use strict';

// Two bundles of filaments and three elliptical orbits, all in viewport coordinates.
// Phase, tilt and density are decorative. Process measurements have their own plots.
function createSilkField({ screen, canvas, knot, entry, sculpture }) {
  const context = canvas.getContext('2d', { alpha: true });
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const TAU = 2 * Math.PI;
  const surface = createSilkSurface(sculpture.querySelector('#silkSurface'), sculpture.querySelector('img'));
  const dust = createSilkParticles(sculpture.querySelector('#silkDust'));
  let proximity = 0, hover = 0, pulseTime = 0;
  const travelers = Array.from({ length: 108 }, (_, i) => ({
    start: ((i + .5) * .61803399) % 1,
    lane: 2 * ((i * .75487767 + .3) % 1) - 1,
    speed: .048 + .024 * ((i * .41421356) % 1),
    size: i % 8 === 0 ? 1.65 : 1.05
  }));
  const stars = Array.from({ length: 72 }, (_, i) => ({
    x: ((i + .5) * .61803399) % 1,
    y: ((i + .33) * .75487767 + Math.sin(i * 2.1) * .11 + 1) % 1,
    radius: i % 9 === 0 ? 1.4 : .7
  }));
  let width = 0, height = 0, frame = 0, last = 0, t = 0, px = 0, py = 0, x = 0, y = 0, openness = 0;
  let ribbonPaint;
  const active = () => !screen.hidden && !screen.inert && !document.hidden;
  function resize() {
    width = screen.clientWidth;
    height = screen.clientHeight;
    if (!context || !width || !height) return;
    const scale = Math.min(1.5, devicePixelRatio);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    ribbonPaint = context.createLinearGradient(0, 0, width, 0);
    for (const [stop, color] of [[0,'#538cc6'],[.19,'#a5a5ff'],[.36,'#bb85f3'],[.52,'#9366bf'],[.69,'#8695ff'],[.84,'#75d1e6'],[1,'#608dc6']]) ribbonPaint.addColorStop(stop, color);
  }
  function ribbonY(column, lane, tilt) {
    return column.mid + lane * column.spread + Math.sin(lane * 1.7 + column.phase) * column.twist + tilt * lane;
  }
  function drawRibbon(cx, cy, dim) {
    context.strokeStyle = ribbonPaint;
    context.lineWidth = .85;
    // The ribbon recedes behind the knot and flares out toward the side instruments.
    const cols = 76, rows = 28;
    const pathColumns = [];
    for (let j = 0; j <= cols; j++) {
      const u = j / cols;
      const d = 2 * u - 1;
      const phase = 8.6 * u + t * .18;
      const flare = (1 - Math.exp(-d*d*8)) * height;
      pathColumns.push({
        x: u * width,
        mid: cy + flare * (.07 * Math.sin(phase * 1.2) + .105 * Math.cos(phase * .7)) + .045 * height * d,
        spread: (.045 + .047 * Math.sin(phase - t*.07)) * flare,
        twist: .065 * flare * Math.sin(phase * .85 - t*.11), phase
      });
    }
    const tilt = (cx - width/2) * .32;
    for (let i = 0; i < rows; i++) {
      const v = i / (rows-1) * 2 - 1;
      context.globalAlpha = dim * (.12 + .17 * Math.pow(Math.abs(v), 2));
      context.beginPath();
      for (let j = 0; j <= cols; j++) {
        const p = pathColumns[j];
        const yy = ribbonY(p, v, tilt);
        if (j === 0) context.moveTo(p.x, yy);
        else context.lineTo(p.x, yy);
      }
      context.stroke();
    }
    for (const dot of travelers) {
      const u = (dot.start + pulseTime * dot.speed) % 1;
      const col = u * cols, idx = Math.floor(col), mix = col - idx;
      const yy = ribbonY(pathColumns[idx], dot.lane, tilt);
      const nextY = ribbonY(pathColumns[idx+1], dot.lane, tilt);
      const x = u * width, y = yy + (nextY-yy)*mix;
      const packet = .5 + .5*Math.cos(18*u - pulseTime*1.8);
      context.globalAlpha = (.26+.68*packet*packet)*dim;
      context.fillStyle = u < .5 ? '#cbb9ff' : '#a6e7fa';
      context.beginPath(); context.arc(x,y,dot.size,0,TAU); context.fill();
      if (dot.size > 1.5) {
        context.strokeStyle = context.fillStyle;
        context.globalAlpha *= .67;
        context.beginPath(); context.moveTo(x,y);
        context.lineTo(x-6,y-(nextY-yy)*6*cols/width); context.stroke();
      }
    }
  }
  function drawOrbit(cx, cy, radius, tilt, ratio, phase, color, dim) {
    context.save();
    context.translate(cx, cy);
    context.rotate(tilt);
    const ry = radius * ratio;
    context.lineWidth = .9;
    context.strokeStyle = color;
    context.globalAlpha = .24 * dim;
    context.beginPath();
    context.ellipse(0, 0, radius, ry, 0, 0, TAU);
    context.stroke();
    context.globalAlpha = .68 * dim;
    context.beginPath();
    context.ellipse(0, 0, radius, ry, 0, phase - .25, phase);
    context.stroke();
    const ox = Math.cos(phase) * radius, oy = Math.sin(phase) * ry;
    const glow = context.createRadialGradient(ox, oy, 0, ox, oy, 8);
    glow.addColorStop(0, color);
    glow.addColorStop(1, 'transparent');
    context.globalAlpha = .65 * dim;
    context.fillStyle = glow;
    context.fillRect(ox-8, oy-8, 16, 16);
    context.globalAlpha = dim;
    context.fillStyle = '#edeefe';
    context.beginPath(); context.arc(ox, oy, 1.7, 0, TAU); context.fill();
    context.restore();
  }
  function paint() {
    if (!context || !width || !height || !ribbonPaint) return;
    const cx = width * .5 + x*9, cy = height * (.46 - openness*.13) + y*5;
    const dim = 1 - openness * .62;
    const r = Math.min(width * .25, height * .39) * (1 - openness * .30);
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#c9ddfd';
    for (const [i, star] of stars.entries()) {
      context.globalAlpha = (.25 + .24 * (1 + Math.sin(i+t*.5))) * dim;
      context.beginPath();
      context.arc(star.x*width + x*star.radius*4, star.y*height + y*star.radius*3, star.radius, 0, TAU);
      context.fill();
    }
    drawRibbon(cx, cy, dim);
    drawOrbit(cx, cy, r, -.25+x*.025, .38+y*.015, .45+t*.19, '#9bbdff', dim);
    drawOrbit(cx, cy, r*.91, .27-x*.04, .49, 3.8-t*.16, '#aa91eb', dim);
    drawOrbit(cx, cy, r*.65, -.94+y*.03, .39, 2.3+t*.21, '#b69bd8', dim*.72);
    context.globalAlpha = 1;
  }
  function tick(now) {
    frame = 0;
    if (!active()) return;
    if (now-last >= 1000/30-1) {
      const dt = Math.min(.09, (now-last)/1000);
      t += dt; last = now;
      proximity += (hover-proximity)*.1;
      pulseTime += dt * (1 + .58*proximity);
      x += (px-x)*.14; y += (py-y)*.14;
      openness += ((entry.hidden ? 0 : 1)-openness)*.14;
      sculpture.style.transform = 'perspective(680px) rotateY('+(x*13).toFixed(2)+'deg) rotateX('+(-y*8).toFixed(2)+'deg)';
      surface.paint(t, x, y);
      dust.paint(pulseTime, proximity, openness);
      paint();
    }
    frame = requestAnimationFrame(tick);
  }
  function sync() {
    cancelAnimationFrame(frame);
    if (!active()) return;
    if (!width || width !== screen.clientWidth || height !== screen.clientHeight) resize();
    if (motion.matches) {
      x = y = px = py = 0;
      openness = entry.hidden ? 0 : 1;
      sculpture.style.removeProperty('transform');
      surface.still();
      dust.paint(pulseTime, 0, openness, true);
      paint();
    } else { last = performance.now(); frame = requestAnimationFrame(tick); }
  }
  screen.addEventListener('pointermove', e => {
    if (motion.matches || e.pointerType === 'touch') return;
    const rect = knot.getBoundingClientRect();
    px = Math.tanh((e.clientX - rect.left - rect.width/2)/(rect.width*.75));
    py = Math.tanh((e.clientY - rect.top - rect.height/2)/(rect.height*.75));
  });
  knot.addEventListener('pointerenter', () => { hover = 1; });
  knot.addEventListener('pointerleave', () => { hover = 0; });
  screen.addEventListener('pointerleave', () => { px = py = hover = 0; });
  new ResizeObserver(sync).observe(screen);
  new MutationObserver(sync).observe(entry, {attributes: true, attributeFilter: ['hidden']});
  motion.addEventListener('change', sync);
  return { sync };
}
