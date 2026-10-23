// public/audio-worklets/recorder-processor.js
//
// The editor's Record tab (VoiceRecorder.tsx): taps the microphone on the audio thread and hands
// the samples to the page in ~85 ms batches, folded to mono (a voice-over is one voice; a stereo
// interface's two identical channels would only double the file). Always reports the input's peak
// level so the meter works before recording starts; only forwards samples while {type:'record',
// on:true}, and acknowledges {on:false} with 'stopped' once the last batch is out. Its one output
// is silent; it's there so the graph keeps pulling the node.

const BATCH = 4096;

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.buffer = new Float32Array(BATCH);
    this.fill = 0;
    this.peak = 0;
    this.sincePeak = 0;
    this.port.onmessage = (e) => {
      if (e.data?.type !== "record") return;
      if (!e.data.on && this.fill > 0) this.flush();
      this.recording = !!e.data.on;
      this.fill = 0;
      // Every sample of the take has been posted by now - the page can close the file.
      if (!e.data.on) this.port.postMessage({ type: "stopped" });
    };
  }

  flush() {
    const out = this.buffer.slice(0, this.fill);
    this.port.postMessage({ type: "samples", samples: out }, [out.buffer]);
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const n = input[0].length;
    const channels = input.length;
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let c = 0; c < channels; c++) v += input[c][i];
      v /= channels;
      const a = v < 0 ? -v : v;
      if (a > this.peak) this.peak = a;
      if (this.recording) {
        this.buffer[this.fill++] = v;
        if (this.fill === BATCH) this.flush();
      }
    }
    this.sincePeak += n;
    if (this.sincePeak >= 1600) {
      this.port.postMessage({ type: "level", peak: this.peak });
      this.peak = 0;
      this.sincePeak = 0;
    }
    return true;
  }
}

registerProcessor("recorder-processor", RecorderProcessor);
