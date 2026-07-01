const path = require('path');
const crypto = require('crypto');

const MIME_TO_EXTENSION = Object.freeze({
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'video/mpeg': '.mpeg',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
});

function getFileExtension(originalName, mimetype) {
  const extFromName = path.extname(String(originalName || '')).toLowerCase();
  if (extFromName) {
    return extFromName;
  }

  return MIME_TO_EXTENSION[mimetype] || '';
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function generateUniqueFilename(originalName, mimetype) {
  const extension = getFileExtension(originalName, mimetype) || '.pdf';
  const baseName = path.basename(String(originalName || 'cv'), extension);
  const safeBase = sanitizeFilenamePart(baseName) || 'cv';
  const timestamp = Math.floor(Date.now() / 1000);
  const randomPart = crypto.randomUUID().split('-')[0];

  return `${safeBase}-${timestamp}-${randomPart}${extension}`;
}

function buildS3Key(folder, fileName) {
  const normalizedFolder = String(folder || '').replace(/^\/+|\/+$/g, '');
  return `${normalizedFolder}/${fileName}`;
}

module.exports = {
  getFileExtension,
  sanitizeFilenamePart,
  generateUniqueFilename,
  buildS3Key,
};
