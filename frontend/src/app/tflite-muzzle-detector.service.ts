import { Injectable } from '@angular/core';

interface YoloCandidate {
  className: 'goodmuzzle' | 'badmuzzle' | 'wetmuzzle';
  classId: number;
  confidence: number;
  bbox: [number, number, number, number];
}

export interface LocalMuzzleDetection {
  accepted: boolean;
  reason: string;
  confidence: number;
  sharpness?: number;
  className: string;
  bbox: [number, number, number, number] | null;
  imageSize: [number, number];
  cropBlob?: Blob;
  cropUrl?: string;
}

type TfliteModel = {
  predict(input: unknown): unknown;
  inputs?: Array<{ shape?: number[] }>;
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
  private readonly modelUrl = '/assets/models/yolo26s_float32.tflite';
  private readonly modelInputSize = 704;
  private readonly minGoodConfidence = 0.70;
  private readonly minBadConfidence = 0.25;
  private readonly minWetConfidence = 0.25;
  private readonly badDominanceMargin = 0.12;
  private readonly minSharpnessScore = 18;
  private readonly classNames = ['badmuzzle', 'goodmuzzle', 'wetmuzzle'] as const;

  private modelPromise?: Promise<TfliteModel>;
  private scriptsPromise?: Promise<void>;
  private preprocessMeta = { scale: 1, padX: 0, padY: 0 };
  private readonly frameCanvas = document.createElement('canvas');
  private readonly letterboxCanvas = document.createElement('canvas');
  private readonly sharpnessCanvas = document.createElement('canvas');

  async isReady(): Promise<boolean> {
    await this.loadModel();
    return true;
  }

  async detectAndCrop(video: HTMLVideoElement): Promise<LocalMuzzleDetection> {
    const model = await this.loadModel();
    const tf = window.tf;
    const sourceWidth = video.videoWidth || 1280;
    const sourceHeight = video.videoHeight || 720;
    const frameCanvas = this.frameCanvas;
    frameCanvas.width = sourceWidth;
    frameCanvas.height = sourceHeight;
    const frameContext = frameCanvas.getContext('2d', { willReadFrequently: true });
    if (!frameContext) throw new Error('Could not read camera frame.');

    frameContext.drawImage(video, 0, 0, sourceWidth, sourceHeight);
    const input = this.frameToTensor(frameCanvas, model);
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
      const label = best.className === 'wetmuzzle' ? 'Wet muzzle' : 'Bad muzzle';
      return {
        accepted: false,
        reason: `${label} rejected (${Math.round(best.confidence * 100)}%).`,
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
        sharpness: Math.round(cropQuality),
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
      sharpness: Math.round(cropQuality),
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
      })().catch((error) => {
        this.modelPromise = undefined;
        throw error;
      });
    }
    return this.modelPromise;
  }

  private async warmupModel(model: TfliteModel): Promise<void> {
    const tf = window.tf;
    if (!tf?.zeros) return;
    let input: unknown;
    try {
      input = tf.zeros(this.modelInputShape(model), 'float32');
      let output: unknown;
      try {
        output = model.predict(input);
        const firstOutput = (Array.isArray(output) ? output[0] : output) as any;
        if (firstOutput?.data) {
          await firstOutput.data();
        }
      } finally {
        this.disposeOutput(output);
      }
    } catch {
      // Shape mismatch is acceptable — first real inference will still work
    } finally {
      if (input) tf.dispose(input);
    }
  }

  private async loadScripts(): Promise<void> {
    if (!this.scriptsPromise) {
      this.scriptsPromise = (async () => {
        await this.loadScript('/assets/vendor/tf-core.min.js');
        await this.loadScript('/assets/vendor/tf-backend-cpu.min.js');
        await this.loadScript('/assets/vendor/tf-tflite.min.js');
        if (!window.tflite?.setWasmPath) {
          throw new Error('TFLite WASM loader is not available.');
        }
        window.tflite.setWasmPath('/assets/tflite-wasm/');
        await window.tf?.setBackend?.('cpu');
        await window.tf?.ready?.();
      })().catch((error) => {
        this.scriptsPromise = undefined;
        throw error;
      });
    }
    return this.scriptsPromise;
  }

  private loadScript(src: string): Promise<void> {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing?.dataset['loaded'] === 'true') return Promise.resolve();
    if (existing?.dataset['failed'] === 'true') existing.remove();
    else if (existing) {
      return new Promise((resolve, reject) => {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error(`Could not load ${src}`)), { once: true });
      });
    }

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => {
        script.dataset['loaded'] = 'true';
        resolve();
      };
      script.onerror = () => {
        script.dataset['failed'] = 'true';
        reject(new Error(`Could not load ${src}`));
      };
      document.head.appendChild(script);
    });
  }

  private modelInputShape(model: TfliteModel): number[] {
    const shape = model.inputs?.[0]?.shape;
    if (Array.isArray(shape) && shape.length === 4 && shape.every((value) => Number.isFinite(value) && value > 0)) {
      return shape;
    }
    return [1, this.modelInputSize, this.modelInputSize, 3];
  }

  private frameToTensor(canvas: HTMLCanvasElement, model: TfliteModel): unknown {
    const tf = window.tf;
    const letterbox = this.letterboxCanvas;
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
    const inputShape = this.modelInputShape(model);
    const channelFirstInput = inputShape[1] === 3;
    const prepared = channelFirstInput ? tf.transpose(normalized, [2, 0, 1]) : normalized;
    const batched = tf.expandDims(prepared, 0);
    tf.dispose([pixels, floatImage, divisor, normalized]);
    if (prepared !== normalized) tf.dispose(prepared);
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
    let bestWet: YoloCandidate | null = null;

    const keepBest = (candidate: YoloCandidate | null) => {
      if (!candidate) return;
      const threshold = candidate.className === 'goodmuzzle'
        ? this.minGoodConfidence
        : (candidate.className === 'wetmuzzle' ? this.minWetConfidence : this.minBadConfidence);
      if (candidate.confidence < threshold) return;
      if (candidate.className === 'goodmuzzle') {
        if (!bestGood || candidate.confidence > bestGood.confidence) bestGood = candidate;
      } else if (candidate.className === 'wetmuzzle') {
        if (!bestWet || candidate.confidence > bestWet.confidence) bestWet = candidate;
      } else if (!bestBad || candidate.confidence > bestBad.confidence) {
        bestBad = candidate;
      }
    };

    // YOLO26 LiteRT exports include NMS and return [1, 300, 6]:
    // x1, y1, x2, y2, confidence, class_id.
    if (shape.length === 3 && shape[shape.length - 1] === 6) {
      const rows = shape[shape.length - 2];
      for (let row = 0; row < rows; row += 1) {
        keepBest(this.nmsCandidate(data, row * 6, sourceWidth, sourceHeight));
      }
      return this.compactCandidates(bestGood, bestBad, bestWet);
    }

    if (shape.length === 3 && shape[1] >= 6 && shape[2] > shape[1]) {
      const channels = shape[1];
      const anchors = shape[2];
      for (let anchor = 0; anchor < anchors; anchor += 1) {
        keepBest(this.channelFirstCandidate(data, channels, anchors, anchor, sourceWidth, sourceHeight));
      }
      return this.compactCandidates(bestGood, bestBad, bestWet);
    }

    const rowLength = shape.length >= 2 ? shape[shape.length - 1] : 6;
    if (!rowLength || rowLength < 6) return [];
    const rowCount = Math.floor(data.length / rowLength);
    for (let row = 0; row < rowCount; row += 1) {
      keepBest(this.rowMajorCandidate(data, row * rowLength, rowLength, sourceWidth, sourceHeight));
    }
    return this.compactCandidates(bestGood, bestBad, bestWet);
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
    const bad = candidates.find((candidate) => candidate.className === 'badmuzzle');
    const wet = candidates.find((candidate) => candidate.className === 'wetmuzzle');

    if (wet && wet.confidence >= this.minWetConfidence) return wet;

    if (good && good.confidence >= this.minGoodConfidence) {
      if (bad && bad.confidence >= good.confidence + this.badDominanceMargin) return bad;
      return good;
    }

    return bad || good;
  }

  private nmsCandidate(
    data: ArrayLike<number>,
    offset: number,
    sourceWidth: number,
    sourceHeight: number
  ): YoloCandidate | null {
    const confidence = Number(data[offset + 4]);
    const classId = Math.round(Number(data[offset + 5]));
    const className = this.classNames[classId];
    if (!className || !Number.isFinite(confidence) || confidence <= 0) return null;

    let x1 = Number(data[offset]);
    let y1 = Number(data[offset + 1]);
    let x2 = Number(data[offset + 2]);
    let y2 = Number(data[offset + 3]);
    if (Math.max(x1, y1, x2, y2) <= 1.5) {
      x1 *= this.modelInputSize;
      y1 *= this.modelInputSize;
      x2 *= this.modelInputSize;
      y2 *= this.modelInputSize;
    }

    const { scale, padX, padY } = this.preprocessMeta;
    x1 = Math.max(0, (x1 - padX) / scale);
    y1 = Math.max(0, (y1 - padY) / scale);
    x2 = Math.min(sourceWidth, (x2 - padX) / scale);
    y2 = Math.min(sourceHeight, (y2 - padY) / scale);
    if (x2 <= x1 || y2 <= y1) return null;

    return { className, classId, confidence, bbox: [x1, y1, x2, y2] };
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
    const sourceWidth = Math.max(1, x2 - x1);
    const sourceHeight = Math.max(1, y2 - y1);
    const outputScale = Math.min(1, 640 / Math.max(sourceWidth, sourceHeight));
    cropCanvas.width = Math.max(1, Math.round(sourceWidth * outputScale));
    cropCanvas.height = Math.max(1, Math.round(sourceHeight * outputScale));
    const context = cropCanvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not crop muzzle.');

    context.drawImage(frameCanvas, x1, y1, sourceWidth, sourceHeight, 0, 0, cropCanvas.width, cropCanvas.height);
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
    const sampleCanvas = this.sharpnessCanvas;
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
    const tilesX = 4;
    const tilesY = 4;
    const clipLimit = 2.0;

    const tileW = Math.ceil(width / tilesX);
    const tileH = Math.ceil(height / tilesY);

    const tileHistograms = new Array(tilesY * tilesX).fill(0).map(() => new Float32Array(256));
    const tileCdfs = new Array(tilesY * tilesX).fill(0).map(() => new Float32Array(256));

    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const hist = tileHistograms[ty * tilesX + tx];
        const startX = tx * tileW;
        const startY = ty * tileH;
        const endX = Math.min(startX + tileW, width);
        const endY = Math.min(startY + tileH, height);
        let count = 0;

        for (let y = startY; y < endY; y++) {
          for (let x = startX; x < endX; x++) {
            const idx = (y * width + x) * 4;
            const luma = Math.round(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
            hist[Math.min(255, Math.max(0, luma))]++;
            count++;
          }
        }

        const actualClip = Math.max(1, Math.round(clipLimit * (count / 256)));
        let excess = 0;
        for (let i = 0; i < 256; i++) {
          if (hist[i] > actualClip) {
            excess += hist[i] - actualClip;
            hist[i] = actualClip;
          }
        }

        const redist = excess / 256;
        let cdf = 0;
        const cdfArray = tileCdfs[ty * tilesX + tx];
        for (let i = 0; i < 256; i++) {
          hist[i] += redist;
          cdf += hist[i];
          cdfArray[i] = cdf / count;
        }
      }
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const luma = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        const lumaClamped = Math.min(255, Math.max(0, luma));

        const tx = (x / tileW) - 0.5;
        const ty = (y / tileH) - 0.5;

        const tx1 = Math.max(0, Math.floor(tx));
        const ty1 = Math.max(0, Math.floor(ty));
        const tx2 = Math.min(tilesX - 1, tx1 + 1);
        const ty2 = Math.min(tilesY - 1, ty1 + 1);

        const xFrac = Math.max(0, Math.min(1, tx - tx1));
        const yFrac = Math.max(0, Math.min(1, ty - ty1));

        const cdf11 = tileCdfs[ty1 * tilesX + tx1][lumaClamped];
        const cdf12 = tileCdfs[ty1 * tilesX + tx2][lumaClamped];
        const cdf21 = tileCdfs[ty2 * tilesX + tx1][lumaClamped];
        const cdf22 = tileCdfs[ty2 * tilesX + tx2][lumaClamped];

        const cdf1 = cdf11 * (1 - xFrac) + cdf12 * xFrac;
        const cdf2 = cdf21 * (1 - xFrac) + cdf22 * xFrac;
        const mappedLuma = cdf1 * (1 - yFrac) + cdf2 * yFrac;

        const factor = mappedLuma * 255 / (luma + 0.001);
        data[idx] = Math.min(255, Math.max(0, r * factor));
        data[idx + 1] = Math.min(255, Math.max(0, g * factor));
        data[idx + 2] = Math.min(255, Math.max(0, b * factor));
      }
    }

    context.putImageData(image, 0, 0);
  }
}
