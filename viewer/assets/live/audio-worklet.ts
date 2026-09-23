declare const sampleRate: number;
declare class AudioWorkletProcessor { port: MessagePort; }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

/** Streaming area resampler: never assumes the browser honored a 16 kHz request. */
class PCMInputProcessor extends AudioWorkletProcessor {
  private weight = 0;
  private sum = 0;
  private samples: number[] = [];
  private targetRate: 16000 | 24000;
  constructor(options?: AudioWorkletNodeOptions) {
    super();
    this.targetRate = options?.processorOptions?.sampleRate === 24000 ? 24000 : 16000;
  }
  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input) return true;
    const ratio = sampleRate / this.targetRate;
    for (const value of input) {
      let remaining = 1;
      while (remaining > 0.000001) {
        const contribution = Math.min(remaining, ratio - this.weight);
        this.sum += value * contribution;
        this.weight += contribution; remaining -= contribution;
        if (this.weight >= ratio - 0.000001) {
          this.samples.push(Math.max(-1, Math.min(1, this.sum / ratio)));
          this.weight = 0; this.sum = 0;
          if (this.samples.length === this.targetRate / 50) {
            const data = new ArrayBuffer(this.samples.length * 2); const view = new DataView(data);
            this.samples.forEach((sample, index) => view.setInt16(index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true));
            this.port.postMessage(data, [data]); this.samples = [];
          }
        }
      }
    }
    return true;
  }
}
registerProcessor('radsysx-pcm-input', PCMInputProcessor);
