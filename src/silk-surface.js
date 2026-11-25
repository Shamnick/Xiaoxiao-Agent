'use strict';

// Shade the original, transparent thread artwork. Keep the PNG visible while
// loading, under reduced motion, and on machines without a working GPU context.
function createSilkSurface(canvas, artwork) {
  let gl, program, phase, gaze, attempted = false;
  function init() {
    attempted = true;
    gl = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, powerPreference: 'low-power' });
    if (!gl) return;
    const vertex = `#version 300 es
      out vec2 uv;
      void main() {
        vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
        uv = p;
        gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
      }`;
    const fragment = `#version 300 es
      precision highp float;
      uniform sampler2D silk;
      uniform float phase;
      uniform vec2 gaze;
      in vec2 uv;
      out vec4 pixel;
      void main() {
        vec2 p = uv - .5;
        float tide = sin(phase * .95);
        float curl = (.065 * tide + .048 * gaze.x) * sin(p.y * 6.0 + phase * .55);
        float c = cos(curl), s = sin(curl);
        p = mat2(c, -s, s, c) * p;
        p.x += .014 * sin(p.y * 8.0 + phase * 1.25) + .009 * gaze.x * cos(p.y * 7.0);
        p.y += .011 * cos(p.x * 9.0 - phase) + .006 * gaze.y;
        vec4 ink = texture(silk, p + .5);
        float sweep = .5 + .5 * cos(p.x * 7.0 + p.y * 3.5 - phase * 1.1);
        vec3 gleam = vec3(.09, .13, .17) * pow(sweep, 7.0);
        vec3 rgb = ink.rgb * (1. + gleam) + gleam * .13;
        pixel = vec4(rgb * ink.a, ink.a);
      }`;
    function compile(type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
      gl.deleteShader(shader);
      return null;
    }
    const vs = compile(gl.VERTEX_SHADER, vertex), fs = compile(gl.FRAGMENT_SHADER, fragment);
    if (!vs || !fs) return;
    const next = gl.createProgram();
    gl.attachShader(next, vs); gl.attachShader(next, fs);
    gl.linkProgram(next);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(next, gl.LINK_STATUS)) { gl.deleteProgram(next); return; }
    gl.useProgram(next);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    for (const name of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, name, gl.LINEAR);
    for (const name of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, name, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, artwork);
    if (gl.getError() !== gl.NO_ERROR) return;
    program = next;
    phase = gl.getUniformLocation(program, 'phase');
    gaze = gl.getUniformLocation(program, 'gaze');
  }
  canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); program = null; canvas.hidden = true; });
  canvas.addEventListener('webglcontextrestored', () => { attempted = false; });
  return {
    still() { canvas.hidden = true; },
    paint(time, x, y) {
      if (!attempted && artwork.complete && artwork.naturalWidth) {
        try { init(); } catch { canvas.hidden = true; }
      }
      if (!program) return;
      const w = Math.min(artwork.naturalWidth, Math.round(artwork.clientWidth * Math.min(devicePixelRatio, 1.5)));
      const h = Math.round(w * artwork.naturalHeight / artwork.naturalWidth);
      if (!w || !h) return;
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
      gl.uniform1f(phase, time);
      gl.uniform2f(gaze, x, y);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      canvas.hidden = false;
    }
  };
}
