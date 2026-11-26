'use strict';

// Sample only during a spoken reply. Frames stay in the analyser and are never recorded.
function monitorSpokenReply(onVoice, onFailure, onListening) {
  let active = true;
  let stream, context, timer;
  function stop() {
    active = false;
    clearInterval(timer);
    stream?.getTracks().forEach(track => track.stop());
    if (context && context.state !== 'closed') void context.close().catch(() => {});
    context = null;
    stream = null;
  }
  function fail() {
    if (!active) return;
    stop();
    onFailure();
  }
  async function start() {
    const capture = await navigator.mediaDevices.getUserMedia({
      video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }
    });
    if (!active) { capture.getTracks().forEach(track => track.stop()); return; }
    stream = capture;
    stream.getAudioTracks()[0].addEventListener('ended', fail, {once:true});
    context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    await context.resume();
    if (!active) return;
    onListening();
    let loudSince = null;
    const samples = new Float32Array(analyser.fftSize);
    timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let energy = 0;
      for (const sample of samples) energy += sample * sample;
      if (Math.sqrt(energy / samples.length) < 0.055) { loudSince = null; return; }
      const now = performance.now();
      loudSince ??= now;
      if (now - loudSince >= 150) { stop(); onVoice(); }
    }, 25);
  }
  void start().catch(fail);
  return stop;
}
