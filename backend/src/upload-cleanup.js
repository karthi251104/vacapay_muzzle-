export async function removeUploadedFile(filePath, fileSystem) {
  if (!filePath) return;
  await fileSystem.unlink(filePath).catch(() => {});
}
