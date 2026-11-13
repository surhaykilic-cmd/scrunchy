// Collects audio into 100 ms mono chunks (the context runs at 16 kHz) and
// posts them to the page, which forwards them to the speech engine.
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(1600);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const n = Math.min(channel.length - offset, this.buffer.length - this.filled);
      this.buffer.set(channel.subarray(offset, offset + n), this.filled);
      this.filled += n;
      offset += n;
      if (this.filled === this.buffer.length) {
        const out = this.buffer;
        this.port.postMessage(out, [out.buffer]);
        this.buffer = new Float32Array(1600);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm', PcmProcessor);
