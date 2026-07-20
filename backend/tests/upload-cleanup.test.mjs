import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { removeUploadedFile } from '../src/upload-cleanup.js';

test('temporary upload cleanup removes a file and tolerates repeated cleanup', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vacapay-upload-'));
  const filePath = path.join(directory, 'capture.tmp');
  await fs.writeFile(filePath, 'temporary image');

  await removeUploadedFile(filePath, fs);
  await assert.rejects(fs.access(filePath));
  await removeUploadedFile(filePath, fs);

  await fs.rm(directory, { recursive: true, force: true });
});
