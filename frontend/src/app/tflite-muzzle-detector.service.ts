import { Injectable } from '@angular/core';

interface YoloCandidate {
  className: 'goodmuzzle' | 'bad muzzle';
  classId: number;
  confidence: number;
  bbox: [number, number, number, number];
}

export interface LocalMuzzleDetection {
  accepted: boolean;
  reason: string;
  confidence: number;
  className: string;
  bbox: [number, number, number, number] | null;
  imageSize: [number, number];
  cropBlob?: Blob;
  cropUrl?: string;
}

type TfliteModel = {
  predict(input: unknown): unknown;
};

declare global {
  interface Window {
    tf?: any;
    tflite?: {
      loadTFLiteModel(modelUrl: string): Promise<TfliteModel>;
      setWasmPath?(path: string): void;
    };
  }
}

@Injectable({ providedIn: 'root' })
export class TfliteMuzzleDetectorService {
  private readonly modelUrl = '/assets/models/best.tflite';
  private readonly modelInputSize = 640;
  private readonly minGoodConfidence = 0.50;
  private readonly minBadConfidence = 0.45;
  private readonly badDominanceMargin = 0.12;
  private readonly minSharpnessScore = 18;
  private readonly classNames = ['bad muzzle', 'goodmuzzle'] as const;
  private readonly tfliteVersion = '0.0.1-alpha.10';

  private modelPromise?: Promise<TfliteModel>;
  private scriptsPromise?: Promise<void>;
  private preprocessMeta = { scale: 1, padX: 0, padY: 0 };

  async isReady(): Promise<boolean> {
    await this.loadModel();
    return true;
  }

  async detectAndCrop(video: HTMLVideoElement): Promise<LocalMuzzleDetection> {
    const model = await this.loadModel();
    const tf = window.tf;
    const sourceWidth = video.videoWidth || 1280;
    const sourceHeight = video.videoHeight || 720;
    const frameCanvas = document.createElement('canvas');
    frameCanvas.width = sourceWidth;
    frameCanvas.height = sourceHeight;
    const frameContext = frameCanvas.getContext('2d', { willReadFrequently: true });
    if (!frameContext) throw new Error('Could not read camera frame.');

    frameContext.drawImage(video, 0, 0, sourceWidth, sourceHeight);
    const input = this.frameToTensor(frameCanvas);
    let rawOutput: unknown;
    try {
      rawOutput = model.predict(input);
    } finally {
      tf.dispose(input);
    }

    const candidates = await this.readCandidates(rawOutput, sourceWidth, sourceHeight);
    this.disposeOutput(rawOutput);
    const best = this.selectBestCandidate(candidates);

    if (!best) {
      return {
        accepted: false,
        reason: 'No muzzle box found.',
        confidence: 0,
        className: 'none',
        bbox: null,
        imageSize: [sourceWidth, sourceHeight]
      };
    }

    if (best.className !== 'goodmuzzle') {
      return {
        accepted: false,
        reason: `Bad muzzle rejected (${Math.round(best.confidence * 100)}%).`,
        confidence: best.confidence,
        className: best.className,
        bbox: best.bbox,
        imageSize: [sourceWidth, sourceHeight]
      };
    }

    if (best.confidence < this.minGoodConfidence) {
      return {
        accepted: false,
        reason: `Good muzzle confidence too low (${Math.round(best.confidence * 100)}%).`,
        confidence: best.confidence,
        className: best.className,
        bbox: best.bbox,
        imageSize: [sourceWidth, sourceHeight]
      };
    }

    const cropQuality = this.measureCropSharpness(frameCanvas, best.bbox);
    if (cropQuality < this.minSharpnessScore) {
      return {
        accepted: false,
        reason: `Image is blurry (${Math.round(cropQuality)} sharpness).`,
        confidence: best.confidence,
        className: best.className,
        bbox: best.bbox,
        imageSize: [sourceWidth, sourceHeight]
      };
    }

    const cropBlob = await this.cropApplyClaheAndBlob(frameCanvas, best.bbox);
    return {
      accepted: true,
      reason: 'Good muzzle accepted.',
      confidence: best.confidence,
      className: best.className,
      bbox: best.bbox,
      imageSize: [sourceWidth, sourceHeight],
      cropBlob,
      cropUrl: URL.createObjectURL(cropBlob)
    };
  }

  private async loadModel(): Promise<TfliteModel> {
    if (!this.modelPromise) {
      this.modelPromise = (async () => {
        await this.loadScripts();
        await window.tf?.ready?.();
        if (!window.tflite?.loadTFLiteModel) {
          throw new Error('TFLite browser runtime did not load.');
        }
        const model = await window.tflite.loadTFLiteModel(this.modelUrl);
        await this.warmupModel(model);
        return model;
      })();
    }
    return this.modelPromise;
  }

  private async warmupModel(model: TfliteModel): Promise<void> {
    const tf = window.tf;
    if (!tf?.zeros) return;
    const input = tf.zeros([1, 3, this.modelInputSize, this.modelInputSize], 'float32');
    let output: unknown;
    try {
      output = model.predict(input);
      const firstOutput = (Array.isArray(output) ? output[0] : output) as any;
      if (firstOutput?.data) {
        await firstOutput.data();
      }
    } finally {
      tf.dispose(input);
      this.disposeOutput(output);
    }
  }

  private async loadScripts(): Promise<void> {
    if (!this.scriptsPromise) {
      this.scriptsPromise = (async () => {
        const tfliteBase = `https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-tflite@${this.tfliteVersion}/dist`;
        await this.loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-core@3.21.0/dist/tf-core.min.js');
        await this.loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-cpu@3.21.0/dist/tf-backend-cpu.min.js');
        await this.loadScript(`${tfliteBase}/tf-tflite.min.js`);
        if (!window.tflite?.setWasmPath) {
          throw new Error('TFLite WASM loader is not available.');
        }
        window.tflite.setWasmPath('/assets/tflite-wasm/');
        await window.tf?.setBackend?.('cpu');
        await window.tf?.ready?.();
      })();
    }
    return this.scriptsPromise;
  }

  private loadScript(src: string): Promise<void> {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(script);
    });
  }

  private frameToTensor(canvas: HTMLCanvasElement): unknown {
    const tf = window.tf;
    const letterbox = document.createElement('canvas');
    letterbox.width = this.modelInputSize;
    letterbox.height = this.modelInputSize;
    const context = letterbox.getContext('2d');
    if (!context) throw new Error('Could not prepare YOLO input.');

    context.fillStyle = 'rgb(114, 114, 114)';
    context.fillRect(0, 0, this.modelInputSize, this.modelInputSize);
    const scale = Math.min(this.modelInputSize / canvas.width, this.modelInputSize / canvas.height);
    const drawWidth = Math.round(canvas.width * scale);
    const drawHeight = Math.round(canvas.height * scale);
    const padX = Math.round((this.modelInputSize - drawWidth) / 2);
    const padY = Math.round((this.modelInputSize - drawHeight) / 2);
    context.drawImage(canvas, 0, 0, canvas.width, canvas.height, padX, padY, drawWidth, drawHeight);
    this.preprocessMeta = { scale, padX, padY };

    const pixels = tf.browser.fromPixels(letterbox);
    const floatImage = tf.cast(pixels, 'float32');
    const divisor = tf.scalar(255);
    const normalized = tf.div(floatImage, divisor);
    const channelFirst = tf.transpose(normalized, [2, 0, 1]);
    const batched = tf.expandDims(channelFirst, 0);
    tf.dispose([pixels, floatImage, divisor, normalized, channelFirst]);
    return batched;
  }

  private async readCandidates(rawOutput: unknown, sourceWidth: number, sourceHeight: number): Promise<YoloCandidate[]> {
    const outputs = Array.isArray(rawOutput) ? rawOutput : [rawOutput];
    const firstTensor = outputs.find((item: any) => item?.dataSync || item?.data);
    if (!firstTensor) return [];

    const shape = (firstTensor as any).shape || [];
    const data = await (firstTensor as any).data() as ArrayLike<number>;
    let bestGood: YoloCandidate | null = null;
    let bestBad: YoloCandidate | null = null;

    const keepBest = (candidate: YoloCandidate | null) => {
      if (!candidate) return;
      const threshold = candidate.className === 'bad muzzle' ? this.minBadConfidence : this.minGoodConfidence;
      if (candidate.confidence < threshold) return;
      if (candidate.className === 'goodmuzzle') {
        if (!bestGood || candidate.confidence > bestGood.confidence) bestGood = candidate;
      } else if (!bestBad || candidate.confidence > bestBad.confidence) {
        bestBad = candidate;
      }
    };

    if (shape.length === 3 && shape[1] >= 6 && shape[2] > shape[1]) {
      const channels = shape[1];
      const anchors = shape[2];
      for (let anchor = 0; anchor < anchors; anchor += 1) {
        keepBest(this.channelFirstCandidate(data, channels, anchors, anchor, sourceWidth, sourceHeight));
      }
      return this.compactCandidates(bestGood, bestBad);
    }

    const rowLength = shape.length >= 2 ? shape[shape.length - 1] : 6;
    if (!rowLength || rowLength < 6) return [];
    const rowCount = Math.floor(data.length / rowLength);
    for (let row = 0; row < rowCount; row += 1) {
      keepBest(this.rowMajorCandidate(data, row * rowLength, rowLength, sourceWidth, sourceHeight));
    }
    return this.compactCandidates(bestGood, bestBad);
  }

  private compactCandidates(...candidates: Array<YoloCandidate | null>): YoloCandidate[] {
    const result: YoloCandidate[] = [];
    candidates.forEach((candidate) => {
      if (candidate) result.push(candidate);
    });
    return result;
  }

  private selectBestCandidate(candidates: YoloCandidate[]): YoloCandidate | undefined {
    const good = candidates.find((candidate) => candidate.className === 'goodmuzzle');
    const bad = candidates.find((candidate) => candidate.className === 'bad muzzle');

    if (good && good.confidence >= this.minGoodConfidence) {
      if (bad && bad.confidence >= good.confidence + this.badDominanceMargin) return bad;
      return good;
    }

    return bad || good;
  }

  private channelFirstCandidate(
    data: ArrayLike<number>,
    channels: number,
    anchors: number,
    anchor: number,
    sourceWidth: number,
    sourceHeight: number
  ): YoloCandidate | null {
    const cx = data[anchor];
    const cy = data[anchors + anchor];
    const width = data[(2 * anchors) + anchor];
    const height = data[(3 * anchors) + anchor];
    const hasObjectness = channels > 6;
    const objectness = hasObjectness ? data[(4 * anchors) + anchor] : 1;
    const classStart = hasObjectness ? 5 : 4;
    let bestClassScore = -Infinity;
    let classId = -1;
    for (let channel = classStart; channel < channels; channel += 1) {
      const score = data[(channel * anchors) + anchor];
      if (score > bestClassScore) {
        bestClassScore = score;
        classId = channel - classStart;
      }
    }
    return this.candidateFromValues(cx, cy, width, height, objectness, bestClassScore, classId, sourceWidth, sourceHeight);
  }

  private rowMajorCandidate(
    data: ArrayLike<number>,
    offset: number,
    rowLength: number,
    sourceWidth: number,
    sourceHeight: number
  ): YoloCandidate | null {
    const cx = data[offset];
    const cy = data[offset + 1];
    const width = data[offset + 2];
    const height = data[offset + 3];
    const hasObjectness = rowLength > 6;
    const objectness = hasObjectness ? data[offset + 4] : 1;
    const classStart = hasObjectness ? 5 : 4;
    let bestClassScore = -Infinity;
    let classId = -1;
    for (let index = classStart; index < rowLength; index += 1) {
      const score = data[offset + index];
      if (score > bestClassScore) {
        bestClassScore = score;
        classId = index - classStart;
      }
    }
    return this.candidateFromValues(cx, cy, width, height, objectness, bestClassScore, classId, sourceWidth, sourceHeight);
  }

  private candidateFromValues(
    cx: number,
    cy: number,
    width: number,
    height: number,
    objectness: number,
    bestClassScore: number,
    classId: number,
    sourceWidth: number,
    sourceHeight: number
  ): YoloCandidate | null {
    if (Math.max(cx, cy, width, height) <= 1.5) {
      cx *= this.modelInputSize;
      cy *= this.modelInputSize;
      width *= this.modelInputSize;
      height *= this.modelInputSize;
    }

    const className = this.classNames[classId];
    if (!className) return null;

    const confidence = objectness * bestClassScore;
    if (!Number.isFinite(confidence) || confidence <= 0) return null;

    const { scale, padX, padY } = this.preprocessMeta;
    const x1 = Math.max(0, ((cx - width / 2) - padX) / scale);
    const y1 = Math.max(0, ((cy - height / 2) - padY) / scale);
    const x2 = Math.min(sourceWidth, ((cx + width / 2) - padX) / scale);
    const y2 = Math.min(sourceHeight, ((cy + height / 2) - padY) / scale);
    if (x2 <= x1 || y2 <= y1) return null;

    return {
      className,
      classId,
      confidence,
      bbox: [x1, y1, x2, y2]
    };
  }

  private disposeOutput(output: unknown): void {
    const tf = window.tf;
    if (!tf || !output) return;
    if (Array.isArray(output)) output.filter(Boolean).forEach((item) => tf.dispose(item));
    else tf.dispose(output);
  }

  private async cropApplyClaheAndBlob(frameCanvas: HTMLCanvasElement, bbox: [number, number, number, number]): Promise<Blob> {
    const [x1, y1, x2, y2] = bbox.map((value) => Math.round(value)) as [number, number, number, number];
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = Math.max(1, x2 - x1);
    cropCanvas.height = Math.max(1, y2 - y1);
    const context = cropCanvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not crop muzzle.');

    context.drawImage(frameCanvas, x1, y1, cropCanvas.width, cropCanvas.height, 0, 0, cropCanvas.width, cropCanvas.height);
    this.applyLocalContrast(context, cropCanvas.width, cropCanvas.height);

    return new Promise((resolve, reject) => {
      cropCanvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Could not encode cropped muzzle.'));
      }, 'image/jpeg', 0.92);
    });
  }

  private measureCropSharpness(frameCanvas: HTMLCanvasElement, bbox: [number, number, number, number]): number {
    const [x1, y1, x2, y2] = bbox.map((value) => Math.round(value)) as [number, number, number, number];
    const width = Math.max(1, x2 - x1);
    const height = Math.max(1, y2 - y1);
    const sampleCanvas = document.createElement('canvas');
    const sampleWidth = 96;
    const sampleHeight = 96;
    sampleCanvas.width = sampleWidth;
    sampleCanvas.height = sampleHeight;
    const context = sampleCanvas.getContext('2d', { willReadFrequently: true });
    if (!context) return 0;

    context.drawImage(frameCanvas, x1, y1, width, height, 0, 0, sampleWidth, sampleHeight);
    const { data } = context.getImageData(0, 0, sampleWidth, sampleHeight);
    let totalGradient = 0;
    let samples = 0;

    for (let y = 1; y < sampleHeight - 1; y += 1) {
      for (let x = 1; x < sampleWidth - 1; x += 1) {
        const left = (y * sampleWidth + x - 1) * 4;
        const right = (y * sampleWidth + x + 1) * 4;
        const up = ((y - 1) * sampleWidth + x) * 4;
        const down = ((y + 1) * sampleWidth + x) * 4;
        const grayLeft = (data[left] + data[left + 1] + data[left + 2]) / 3;
        const grayRight = (data[right] + data[right + 1] + data[right + 2]) / 3;
        const grayUp = (data[up] + data[up + 1] + data[up + 2]) / 3;
        const grayDown = (data[down] + data[down + 1] + data[down + 2]) / 3;
        totalGradient += Math.abs(grayRight - grayLeft) + Math.abs(grayDown - grayUp);
        samples += 2;
      }
    }

    return samples ? totalGradient / samples : 0;
  }

  private applyLocalContrast(context: CanvasRenderingContext2D, width: number, height: number): void {
    const image = context.getImageData(0, 0, width, height);
    const data = image.data;
    let min = 255;
    let max = 0;
    for (let index = 0; index < data.length; index += 4) {
      const gray = Math.round((data[index] + data[index + 1] + data[index + 2]) / 3);
      min = Math.min(min, gray);
      max = Math.max(max, gray);
    }

    const range = Math.max(24, max - min);
    for (let index = 0; index < data.length; index += 4) {
      for (let channel = 0; channel < 3; channel += 1) {
        const stretched = ((data[index + channel] - min) / range) * 255;
        data[index + channel] = Math.max(0, Math.min(255, stretched));
      }
    }
    context.putImageData(image, 0, 0);
  }
}
