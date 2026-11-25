'use strict';

// Draw the strands when the reading area changes size. Only the few travelling
// lights are animated, by CSS, while an actual response is in progress.
function installConversationField(field) {
  const canvas = field.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const lights = Array.from({length: 6}, () => field.appendChild(document.createElement('i')));
  const noise = n => (Math.sin(n * 83.17 + 3.41) * 8241.43) % 1;
  function draw(width, height) {
    if (!width || !height) return;
    const scale = Math.min(devicePixelRatio, 1.5);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const margin = Math.max(0, (width - 740) * .5);
    const breadth = Math.min(278, Math.max(32, margin * .91));
    const intensity = Math.min(1, breadth / 150);
    for (let side = 0; side < 2; side++) {
      const mirror = x => side ? width - x : x;
      const tint = side ? '132,190,218' : '172,152,235';
      const paint = ctx.createLinearGradient(mirror(-15), 0, mirror(breadth + 12), 0);
      paint.addColorStop(0, 'rgba('+tint+',.16)');
      paint.addColorStop(.56, 'rgba('+tint+',.52)');
      paint.addColorStop(1, 'rgba('+tint+',.21)');
      ctx.strokeStyle = paint;
      const strand = (t,lane) => {
        const bend = side ? .47 : .68;
        const envelope = Math.sin(Math.PI*t);
        const sweep = Math.exp(-Math.pow((t-bend)*3.1,2));
        const fold = Math.sin(7.4*t + (side ? 1.8 : -.8));
        const x = breadth*(-.16 + .97*sweep + envelope*(.14*lane + .27*fold*lane + .035*lane*lane));
        return [mirror(x), height*(.04+t*.91 + lane*.029*envelope)];
      };
      for (let row = 0; row < 21; row++) {
        const lane = (row-10)/10;
        ctx.globalAlpha = intensity*(.42 + .42*Math.abs(lane));
        ctx.lineWidth = .8;
        ctx.beginPath();
        for (let i = 0; i <= 64; i++) {
          const [x,y] = strand(i/64,lane);
          if (i === 0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
        }
        ctx.stroke();
      }
      // Sparse points stay outside the text measure, including in a narrow split.
      ctx.fillStyle = 'rgb('+tint+')';
      for (let i = 0; i < 46; i++) {
        const x = mirror(Math.abs(noise(i+side+1))*breadth);
        const y = Math.abs(noise(i+side+103))*height;
        ctx.globalAlpha = intensity*(.23+.38*Math.abs(noise(i+11)));
        ctx.beginPath();
        ctx.arc(x,y,i % 11 === 0 ? 1.25 : .65,0,2*Math.PI);
        ctx.fill();
      }
      for (let i = 0; i < 3; i++) {
        const light = lights[side*3+i];
        const lane = -.64+i*.65;
        const points = Array.from({length: 58}, (_, j) => {
          const [x,y] = strand(j/57,lane);
          return (j ? 'L' : 'M')+x.toFixed(1)+' '+y.toFixed(1);
        });
        light.style.offsetPath = 'path("'+points.join(' ')+'")';
      }
    }
    ctx.globalAlpha = 1;
  }
  new ResizeObserver(([entry]) => draw(entry.contentRect.width, entry.contentRect.height)).observe(field);
}
