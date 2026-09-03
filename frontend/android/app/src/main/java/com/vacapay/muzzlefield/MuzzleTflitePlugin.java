package com.vacapay.muzzlefield;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.tensorflow.lite.Interpreter;
import org.tensorflow.lite.Tensor;

import java.io.FileInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.MappedByteBuffer;
import java.nio.channels.FileChannel;
import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(name = "MuzzleTflite")
public class MuzzleTflitePlugin extends Plugin {
  private static final String MODEL_ASSET = "public/assets/models/yolo26s_float32.tflite";
  private Interpreter interpreter;
  private int inputSize = 704;
  private boolean channelFirstInput = false;
  private boolean interpreterWarmed = false;
  private int[] outputShape = new int[0];

  @Override
  protected void handleOnDestroy() {
    if (interpreter != null) {
      interpreter.close();
      interpreter = null;
    }
  }

  @PluginMethod
  public void status(PluginCall call) {
    try {
      ensureInterpreter();
      JSObject result = new JSObject();
      result.put("inputSize", inputSize);
      result.put("outputShape", toJsArray(outputShape));
      call.resolve(result);
    } catch (Exception error) {
      call.reject("Could not initialize the on-phone muzzle model: " + error.getMessage(), error);
    }
  }

  @PluginMethod
  public void detect(PluginCall call) {
    String imageBase64 = call.getString("imageBase64");
    if (imageBase64 == null || imageBase64.trim().isEmpty()) {
      call.reject("A camera image is required for muzzle detection.");
      return;
    }

    try {
      ensureInterpreter();
      Bitmap source = decodeImage(imageBase64);
      if (source == null) throw new IllegalArgumentException("Could not decode the camera image.");

      int sourceWidth = source.getWidth();
      int sourceHeight = source.getHeight();
      int sourceSize = Math.min(sourceWidth, sourceHeight);
      int cropX = (sourceWidth - sourceSize) / 2;
      int cropY = (sourceHeight - sourceSize) / 2;
      Bitmap centerCrop = Bitmap.createBitmap(source, cropX, cropY, sourceSize, sourceSize);
      Bitmap resized = Bitmap.createScaledBitmap(centerCrop, inputSize, inputSize, true);

      ByteBuffer input = bitmapToFloatBuffer(resized);
      ByteBuffer outputBuffer = ByteBuffer.allocateDirect(elementCount(outputShape) * 4)
        .order(ByteOrder.nativeOrder());
      interpreter.run(input, outputBuffer);
      outputBuffer.rewind();
      FloatBuffer output = outputBuffer.asFloatBuffer();

      JSArray candidates = parseCandidates(output, sourceWidth, sourceHeight, sourceSize, cropX, cropY);
      JSObject result = new JSObject();
      result.put("candidates", candidates);
      call.resolve(result);

      if (resized != centerCrop) resized.recycle();
      centerCrop.recycle();
      source.recycle();
    } catch (Exception error) {
      call.reject("On-phone muzzle check failed: " + error.getMessage(), error);
    }
  }

  private synchronized void ensureInterpreter() throws IOException {
    if (interpreter != null) return;
    Interpreter.Options options = new Interpreter.Options();
    options.setNumThreads(2);
    interpreter = new Interpreter(loadModelFile(), options);
    Tensor input = interpreter.getInputTensor(0);
    int[] inputShape = input.shape();
    if (inputShape.length == 4 && inputShape[1] == 3) {
      channelFirstInput = true;
      inputSize = inputShape[2];
    } else if (inputShape.length == 4 && inputShape[3] == 3) {
      channelFirstInput = false;
      inputSize = inputShape[1];
    } else {
      throw new IllegalStateException("Expected an RGB image model, received input shape " + shapeText(inputShape));
    }
    outputShape = interpreter.getOutputTensor(0).shape();
    warmUpInterpreter();
    Log.i("MuzzleTflite", "Ready: input=" + shapeText(inputShape) + ", output=" + shapeText(outputShape));
  }

  private void warmUpInterpreter() {
    if (interpreterWarmed) return;
    ByteBuffer input = ByteBuffer.allocateDirect(inputSize * inputSize * 3 * 4)
      .order(ByteOrder.nativeOrder());
    ByteBuffer output = ByteBuffer.allocateDirect(elementCount(outputShape) * 4)
      .order(ByteOrder.nativeOrder());
    long startedAt = System.currentTimeMillis();
    interpreter.run(input, output);
    interpreterWarmed = true;
    Log.i("MuzzleTflite", "Warm-up inference completed in " + (System.currentTimeMillis() - startedAt) + " ms");
  }

  private MappedByteBuffer loadModelFile() throws IOException {
    android.content.res.AssetFileDescriptor descriptor = getContext().getAssets().openFd(MODEL_ASSET);
    try (FileInputStream input = new FileInputStream(descriptor.getFileDescriptor());
         FileChannel channel = input.getChannel()) {
      return channel.map(FileChannel.MapMode.READ_ONLY, descriptor.getStartOffset(), descriptor.getDeclaredLength());
    } finally {
      descriptor.close();
    }
  }

  private Bitmap decodeImage(String value) {
    String encoded = value.contains(",") ? value.substring(value.indexOf(',') + 1) : value;
    byte[] data = Base64.decode(encoded, Base64.DEFAULT);
    return BitmapFactory.decodeByteArray(data, 0, data.length);
  }

  private ByteBuffer bitmapToFloatBuffer(Bitmap bitmap) {
    ByteBuffer buffer = ByteBuffer.allocateDirect(inputSize * inputSize * 3 * 4).order(ByteOrder.nativeOrder());
    int[] pixels = new int[inputSize * inputSize];
    bitmap.getPixels(pixels, 0, inputSize, 0, 0, inputSize, inputSize);
    if (channelFirstInput) {
      for (int pixel : pixels) buffer.putFloat(((pixel >> 16) & 0xFF) / 255f);
      for (int pixel : pixels) buffer.putFloat(((pixel >> 8) & 0xFF) / 255f);
      for (int pixel : pixels) buffer.putFloat((pixel & 0xFF) / 255f);
    } else {
      for (int pixel : pixels) {
        buffer.putFloat(((pixel >> 16) & 0xFF) / 255f);
        buffer.putFloat(((pixel >> 8) & 0xFF) / 255f);
        buffer.putFloat((pixel & 0xFF) / 255f);
      }
    }
    buffer.rewind();
    return buffer;
  }

  private JSArray parseCandidates(
    FloatBuffer output,
    int sourceWidth,
    int sourceHeight,
    int sourceSize,
    int cropX,
    int cropY
  ) {
    float[] values = new float[output.remaining()];
    output.get(values);
    List<Candidate> best = new ArrayList<>();
    if (outputShape.length == 3 && outputShape[2] == 6) {
      int rows = outputShape[1];
      for (int row = 0; row < rows; row++) {
        Candidate candidate = nmsCandidate(values, row * 6, sourceWidth, sourceHeight, sourceSize, cropX, cropY);
        if (candidate != null && candidate.confidence >= 0.20f) best.add(candidate);
      }
    } else if (outputShape.length == 3 && outputShape[1] >= 6 && outputShape[2] > outputShape[1]) {
      int channels = outputShape[1];
      int anchors = outputShape[2];
      for (int anchor = 0; anchor < anchors; anchor++) {
        keepBest(best, rawCandidate(values, channels, anchors, anchor, sourceWidth, sourceHeight, sourceSize, cropX, cropY));
      }
    } else if (outputShape.length == 3 && outputShape[2] >= 6 && outputShape[1] > outputShape[2]) {
      int anchors = outputShape[1];
      int channels = outputShape[2];
      for (int anchor = 0; anchor < anchors; anchor++) {
        keepBest(best, rowMajorRawCandidate(values, channels, anchor, sourceWidth, sourceHeight, sourceSize, cropX, cropY));
      }
    } else {
      throw new IllegalStateException("Unsupported YOLO output shape " + shapeText(outputShape));
    }

    JSArray result = new JSArray();
    for (Candidate candidate : best) {
      JSObject item = new JSObject();
      item.put("classId", candidate.classId);
      item.put("confidence", candidate.confidence);
      item.put("bbox", toJsArray(candidate.bbox));
      result.put(item);
    }
    return result;
  }

  private Candidate nmsCandidate(float[] values, int offset, int sourceWidth, int sourceHeight, int sourceSize, int cropX, int cropY) {
    int classId = Math.round(values[offset + 5]);
    float confidence = values[offset + 4];
    if (classId < 0 || classId > 2 || confidence <= 0) return null;
    return mapCandidate(classId, confidence, values[offset], values[offset + 1], values[offset + 2], values[offset + 3], sourceWidth, sourceHeight, sourceSize, cropX, cropY);
  }

  private Candidate rawCandidate(float[] values, int channels, int anchors, int anchor, int sourceWidth, int sourceHeight, int sourceSize, int cropX, int cropY) {
    int classStart = 4;
    float bestScore = -Float.MAX_VALUE;
    int classId = -1;
    for (int channel = classStart; channel < channels; channel++) {
      float score = values[(channel * anchors) + anchor];
      if (score > bestScore) {
        bestScore = score;
        classId = channel - classStart;
      }
    }
    if (classId < 0 || classId > 2 || bestScore <= 0) return null;
    float centerX = values[anchor];
    float centerY = values[anchors + anchor];
    float width = values[(2 * anchors) + anchor];
    float height = values[(3 * anchors) + anchor];
    return mapCandidate(classId, bestScore, centerX - width / 2, centerY - height / 2, centerX + width / 2, centerY + height / 2, sourceWidth, sourceHeight, sourceSize, cropX, cropY);
  }

  private Candidate rowMajorRawCandidate(float[] values, int channels, int anchor, int sourceWidth, int sourceHeight, int sourceSize, int cropX, int cropY) {
    int offset = anchor * channels;
    int classId = -1;
    float bestScore = -Float.MAX_VALUE;
    for (int channel = 4; channel < channels; channel++) {
      float score = values[offset + channel];
      if (score > bestScore) {
        bestScore = score;
        classId = channel - 4;
      }
    }
    if (classId < 0 || classId > 2 || bestScore <= 0) return null;
    float centerX = values[offset];
    float centerY = values[offset + 1];
    float width = values[offset + 2];
    float height = values[offset + 3];
    return mapCandidate(classId, bestScore, centerX - width / 2, centerY - height / 2, centerX + width / 2, centerY + height / 2, sourceWidth, sourceHeight, sourceSize, cropX, cropY);
  }

  private Candidate mapCandidate(int classId, float confidence, float left, float top, float right, float bottom, int sourceWidth, int sourceHeight, int sourceSize, int cropX, int cropY) {
    if (Math.max(Math.max(left, top), Math.max(right, bottom)) <= 1.5f) {
      left *= inputSize;
      top *= inputSize;
      right *= inputSize;
      bottom *= inputSize;
    }
    float scale = (float) inputSize / sourceSize;
    float x1 = Math.max(0, (left / scale) + cropX);
    float y1 = Math.max(0, (top / scale) + cropY);
    float x2 = Math.min(sourceWidth, (right / scale) + cropX);
    float y2 = Math.min(sourceHeight, (bottom / scale) + cropY);
    if (x2 <= x1 || y2 <= y1) return null;
    return new Candidate(classId, confidence, new float[] { x1, y1, x2, y2 });
  }

  private void keepBest(List<Candidate> candidates, Candidate candidate) {
    if (candidate == null) return;
    for (int index = 0; index < candidates.size(); index++) {
      if (candidates.get(index).classId == candidate.classId) {
        if (candidate.confidence > candidates.get(index).confidence) candidates.set(index, candidate);
        return;
      }
    }
    candidates.add(candidate);
  }

  private int elementCount(int[] shape) {
    int count = 1;
    for (int value : shape) count *= value;
    return count;
  }

  private JSArray toJsArray(int[] values) {
    JSArray result = new JSArray();
    for (int value : values) result.put(value);
    return result;
  }

  private JSArray toJsArray(float[] values) {
    JSArray result = new JSArray();
    for (float value : values) {
      try {
        result.put(value);
      } catch (org.json.JSONException error) {
        throw new IllegalStateException("Invalid bounding-box value from muzzle model.", error);
      }
    }
    return result;
  }

  private String shapeText(int[] shape) {
    StringBuilder builder = new StringBuilder("[");
    for (int index = 0; index < shape.length; index++) {
      if (index > 0) builder.append(", ");
      builder.append(shape[index]);
    }
    return builder.append(']').toString();
  }

  private static class Candidate {
    final int classId;
    final float confidence;
    final float[] bbox;

    Candidate(int classId, float confidence, float[] bbox) {
      this.classId = classId;
      this.confidence = confidence;
      this.bbox = bbox;
    }
  }
}
