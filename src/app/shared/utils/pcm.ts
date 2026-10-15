/** DataView is deliberately little endian, independent of the host platform. */
export function pcm16ToFloat32(data: ArrayBuffer): Float32Array<ArrayBuffer> {
  if (data.byteLength % 2 !== 0) throw new Error('Le flux PCM contient un échantillon incomplet.');
  const view = new DataView(data);
  const result = new Float32Array(data.byteLength / 2);
  for (let i = 0; i < result.length; i++) result[i] = view.getInt16(i * 2, true) / 32768;
  return result;
}

/** Average samples within each output interval to downsample mono to 16 kHz. */
export function monoToPcm16(
  samples: Float32Array,
  inputRate: number,
  outputRate = 16000,
): ArrayBuffer {
  if (inputRate <= 0 || outputRate <= 0) throw new Error('Fréquence audio invalide.');
  const ratio = inputRate / outputRate;
  const length = Math.floor(samples.length / ratio);
  const result = new ArrayBuffer(length * 2);
  const view = new DataView(result);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    const sample = Math.max(-1, Math.min(1, sum / (end - start)));
    view.setInt16(i * 2, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true);
  }
  return result;
}
