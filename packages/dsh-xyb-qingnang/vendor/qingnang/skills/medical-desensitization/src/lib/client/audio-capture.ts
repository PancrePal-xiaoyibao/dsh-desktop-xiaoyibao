const TARGET_SAMPLE_RATE = 16_000;
const TARGET_CHANNEL_COUNT = 1;
const CHUNK_DURATION_MS = 200;

export type AudioCaptureResult = {
  sampleCount: number;
  wavBlob: Blob;
};

export type AudioCaptureSession = {
  stop: () => Promise<AudioCaptureResult>;
};

type StartAudioCaptureOptions = {
  onChunk?: (chunk: ArrayBuffer) => void;
};

export async function startAudioCapture(
  options: StartAudioCaptureOptions = {}
): Promise<AudioCaptureSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: TARGET_CHANNEL_COUNT,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const audioContext = new AudioContext();
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const muteGain = audioContext.createGain();
  const recordedChunks: Int16Array[] = [];
  const targetChunkSamples = Math.round(
    (TARGET_SAMPLE_RATE * CHUNK_DURATION_MS) / 1000
  );

  muteGain.gain.value = 0;

  let stopped = false;
  let pendingSamples = new Int16Array(0);

  processor.onaudioprocess = (event) => {
    if (stopped) {
      return;
    }

    const channelData = event.inputBuffer.getChannelData(0);
    const pcmChunk = resampleAndConvertToInt16(
      channelData,
      event.inputBuffer.sampleRate,
      TARGET_SAMPLE_RATE
    );

    if (pcmChunk.length === 0) {
      return;
    }

    recordedChunks.push(pcmChunk);
    pendingSamples = concatInt16Arrays(pendingSamples, pcmChunk);

    while (pendingSamples.length >= targetChunkSamples) {
      const nextChunk = pendingSamples.slice(0, targetChunkSamples);
      pendingSamples = pendingSamples.slice(targetChunkSamples);
      options.onChunk?.(copyArrayBuffer(nextChunk.buffer));
    }
  };

  source.connect(processor);
  processor.connect(muteGain);
  muteGain.connect(audioContext.destination);

  return {
    stop: async () => {
      if (stopped) {
        return {
          sampleCount: 0,
          wavBlob: new Blob([], { type: 'audio/wav' }),
        };
      }

      stopped = true;

      if (pendingSamples.length > 0) {
        options.onChunk?.(copyArrayBuffer(pendingSamples.buffer));
      }

      processor.disconnect();
      source.disconnect();
      muteGain.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      await audioContext.close();

      const samples = mergeInt16Chunks(recordedChunks);

      return {
        sampleCount: samples.length,
        wavBlob: createWavBlob(samples, TARGET_SAMPLE_RATE),
      };
    },
  };
}

function resampleAndConvertToInt16(
  input: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number
) {
  if (sourceSampleRate === targetSampleRate) {
    return float32ToInt16(input);
  }

  const resampleRatio = sourceSampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.round(input.length / resampleRatio));
  const output = new Int16Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * resampleRatio;
    const leftIndex = Math.floor(sourceIndex);
    const rightIndex = Math.min(leftIndex + 1, input.length - 1);
    const interpolation = sourceIndex - leftIndex;
    const sample =
      input[leftIndex] +
      (input[rightIndex] - input[leftIndex]) * interpolation;

    output[index] = clampSample(sample);
  }

  return output;
}

function float32ToInt16(input: Float32Array) {
  const output = new Int16Array(input.length);

  for (let index = 0; index < input.length; index += 1) {
    output[index] = clampSample(input[index]);
  }

  return output;
}

function clampSample(sample: number) {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

function concatInt16Arrays(left: Int16Array, right: Int16Array) {
  const output = new Int16Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}

function mergeInt16Chunks(chunks: Int16Array[]) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Int16Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

function createWavBlob(samples: Int16Array, sampleRate: number) {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const dataLength = samples.length * 2;
  const pcmData = new Uint8Array(dataLength);

  writeAsciiString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAsciiString(view, 8, 'WAVE');
  writeAsciiString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, TARGET_CHANNEL_COUNT, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * TARGET_CHANNEL_COUNT * 2, true);
  view.setUint16(32, TARGET_CHANNEL_COUNT * 2, true);
  view.setUint16(34, 16, true);
  writeAsciiString(view, 36, 'data');
  view.setUint32(40, dataLength, true);
  pcmData.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));

  return new Blob([header, pcmData], {
    type: 'audio/wav',
  });
}

function writeAsciiString(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function copyArrayBuffer(buffer: ArrayBufferLike) {
  const view = new Uint8Array(buffer);
  return view.slice().buffer;
}
