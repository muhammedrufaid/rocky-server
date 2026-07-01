const S3_FOLDERS = Object.freeze({
  IMAGES: 'images',
  VIDEOS: 'videos',
  PDFS: 'pdfs',
  CVS: 'cvs',
});

const PUBLIC_FOLDERS = Object.freeze([
  S3_FOLDERS.IMAGES,
  S3_FOLDERS.VIDEOS,
  S3_FOLDERS.PDFS,
]);

const PRIVATE_FOLDERS = Object.freeze([S3_FOLDERS.CVS]);

const ALLOWED_FOLDERS = Object.freeze([...PUBLIC_FOLDERS, ...PRIVATE_FOLDERS]);

const IMAGE_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);

const VIDEO_MIME_TYPES = Object.freeze([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
  'video/mpeg',
]);

const PDF_MIME_TYPES = Object.freeze(['application/pdf']);

const CV_MIME_TYPES = Object.freeze([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const DEFAULT_MAX_FILE_SIZES = Object.freeze({
  image: 5 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  pdf: 10 * 1024 * 1024,
  cv: 10 * 1024 * 1024,
});

function parseMaxSize(envValue, fallback) {
  const parsed = Number(envValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getMaxFileSize(type) {
  const envMap = {
    image: 'AWS_S3_MAX_IMAGE_SIZE',
    video: 'AWS_S3_MAX_VIDEO_SIZE',
    pdf: 'AWS_S3_MAX_PDF_SIZE',
    cv: 'AWS_S3_MAX_CV_SIZE',
  };

  return parseMaxSize(process.env[envMap[type]], DEFAULT_MAX_FILE_SIZES[type]);
}

function isAllowedFolder(folder) {
  return ALLOWED_FOLDERS.includes(folder);
}

function isPublicFolder(folder) {
  return PUBLIC_FOLDERS.includes(folder);
}

module.exports = {
  S3_FOLDERS,
  PUBLIC_FOLDERS,
  PRIVATE_FOLDERS,
  ALLOWED_FOLDERS,
  IMAGE_MIME_TYPES,
  VIDEO_MIME_TYPES,
  PDF_MIME_TYPES,
  CV_MIME_TYPES,
  DEFAULT_MAX_FILE_SIZES,
  getMaxFileSize,
  isAllowedFolder,
  isPublicFolder,
};
