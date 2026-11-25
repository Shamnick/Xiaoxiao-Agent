'use strict';

// Three visible runs of thread in artwork coordinates. Each track ends before
// its face folds underneath another. Short-lived motes spread out at the exits.
function createSilkParticles(canvas) {
  const ctx = canvas.getContext('2d');
  const sketchWidth = 550, sketchHeight = 379;
  const tracks = [
    { color: 0, points: [[132,208],[139,166],[157,126],[182,90],[213,63],[242,54],[267,59],[286,80],[296,105]] },
    { color: 1, points: [[139,172],[159,146],[186,140],[216,150],[245,160],[275,157],[309,146],[343,136],[376,130],[407,132],[426,146],[424,161],[406,177]] },
    { color: 2, points: [[324,204],[337,234],[345,264],[342,292],[325,314],[303,328],[273,335],[241,332],[212,322],[183,305],[160,283],[141,257]] }
  ];
  const palette = ['161,180,255', '255,192,139', '244,159,222'];
  const glow = palette.map(rgb => {
    const tile = document.createElement('canvas');
    tile.width = tile.height = 40;
    const brush = tile.getContext('2d');
    const gradient = brush.createRadialGradient(20,20,0,20,20,20);
    gradient.addColorStop(0, 'rgba(255,249,247,1)');
    gradient.addColorStop(.15, 'rgba(255,244,245,.98)');
    gradient.addColorStop(.32, 'rgba('+rgb+',.78)');
    gradient.addColorStop(1, 'rgba('+rgb+',0)');
    brush.fillStyle = gradient;
    brush.fillRect(0,0,40,40);
    return tile;
  });
  const fract = n => n - Math.floor(n);
  const rand = n => fract(Math.sin(n * 71.329 + 2.21) * 43758.5453);
  const lerp = (a,b,m) => a + (b-a)*m;
  // Lookups are equally spaced in arc length, so a pulse retains its speed around bends.
  function bake(points) {
    const path = [], distances = [];
    let length = 0;
    for (let segment = 0; segment < points.length - 1; segment++) {
      const a = points[Math.max(0,segment-1)], b = points[segment], c = points[segment+1], d = points[Math.min(points.length-1,segment+2)];
      for (let j = 0; j < 12; j++) {
        const u = j/12, u2 = u*u, u3 = u2*u;
        const point = [0,1].map(k => .5*((2*b[k])+(-a[k]+c[k])*u+(2*a[k]-5*b[k]+4*c[k]-d[k])*u2+(-a[k]+3*b[k]-3*c[k]+d[k])*u3));
        if (path.length) length += Math.hypot(point[0]-path.at(-1)[0], point[1]-path.at(-1)[1]);
        distances.push(length); path.push(point);
      }
    }
    const end = points.at(-1);
    length += Math.hypot(end[0]-path.at(-1)[0], end[1]-path.at(-1)[1]);
    distances.push(length); path.push(end);
    let index = 1;
    return Array.from({length: 193}, (_, i) => {
      const s = length*i/192;
      while (index < path.length-1 && distances[index] < s) index++;
      const a = path[index-1], b = path[index];
      const dx = b[0]-a[0], dy = b[1]-a[1], norm = Math.hypot(dx,dy) || 1;
      const u = (s-distances[index-1])/(distances[index]-distances[index-1] || 1);
      return {x:lerp(a[0],b[0],u), y:lerp(a[1],b[1],u), tx:dx/norm, ty:dy/norm};
    });
  }
  const paths = tracks.map(track => bake(track.points));
  const motes = Array.from({length: 165}, (_, i) => ({
    track: i%3, seed: rand(i+9), offset: (rand(i+174)-.5)*50,
    speed: .14+.075*rand(i+61), size: .72+1.45*rand(i+8), lifted: i%5 === 0
  }));
  let oldWidth = 0, oldHeight = 0;
  function paint(time, near, open, still = false) {
    if (!ctx) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const width = Math.round(w*Math.min(devicePixelRatio,1.5)), height = Math.round(h*Math.min(devicePixelRatio,1.5));
    if (width !== oldWidth || height !== oldHeight) {
      canvas.width = oldWidth = width;
      canvas.height = oldHeight = height;
    }
    ctx.setTransform(width/sketchWidth,0,0,height/sketchHeight,0,0);
    ctx.clearRect(0,0,sketchWidth,sketchHeight);
    ctx.globalCompositeOperation = 'lighter';
    const quiet = 1-open*.66;
    for (const [i,m] of motes.entries()) {
      const t = fract(m.seed+time*m.speed);
      const j = t*192, a = paths[m.track][Math.floor(j)], b = paths[m.track][Math.floor(j)+1];
      // Use the same travel direction on neighbouring lanes to form a visible wave.
      const wave = .5+.5*Math.cos(6.283*(t-time*.30-m.track*.22));
      const drift = m.lifted ? Math.max(0,t-.50)*95*(1+near*.45) : 0;
      const lane = m.offset + drift + 2.5*Math.sin(time*1.6+i*.8+t*6);
      const x = lerp(a.x,b.x,j%1) - a.ty*lane;
      const y = lerp(a.y,b.y,j%1) + a.tx*lane;
      const edge = Math.min(1,t*12,(1-t)*10);
      const light = (.31+.65*wave*wave)*quiet*edge;
      const radius = m.size*(.81+.47*wave+.12*near);
      ctx.globalAlpha = light;
      ctx.strokeStyle = 'rgb('+palette[m.track]+')';
      ctx.lineWidth = Math.max(.8,radius*.72);
      ctx.beginPath(); ctx.moveTo(x,y);
      const tail = still ? 1.2 : 2+wave*5+near*1.5;
      ctx.lineTo(x-a.tx*tail,y-a.ty*tail); ctx.stroke();
      const size = radius*4.8;
      ctx.drawImage(glow[m.track], x-size/2, y-size/2, size,size);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  return {paint};
}
