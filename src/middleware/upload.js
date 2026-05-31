const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const path = require('path');
const cloudinary = require('../config/cloudinary');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatTimestampForFilename(date) {
  const yyyy = date.getFullYear();
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());

  let hours = date.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;

  const hh = pad2(hours);
  const min = pad2(date.getMinutes());

  return `${yyyy}-${mm}-${dd}_${hh}-${min}-${ampm}`;
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9-_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function buildRenamedFilename(originalName, mimetype) {
  const safeOriginal = String(originalName || 'cv');
  const extFromName = path.extname(safeOriginal);
  const ext = extFromName
    || (mimetype === 'application/pdf' ? '.pdf' : '')
    || (mimetype === 'application/msword' ? '.doc' : '')
    || (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ? '.docx' : '');

  const baseName = extFromName ? path.basename(safeOriginal, extFromName) : safeOriginal;
  const safeBase = sanitizeFilenamePart(baseName) || 'cv';

  const ts = formatTimestampForFilename(new Date());
  const updatedBase = `${safeBase}_${ts}`;
  const updatedFileName = `${updatedBase}${ext || ''}`;

  const format = ext ? ext.replace(/^\./, '') : undefined;

  return { updatedBase, updatedFileName, originalFileName: safeOriginal, ext, format };
}

const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const { updatedBase, updatedFileName, originalFileName, ext } = buildRenamedFilename(
      file.originalname,
      file.mimetype
    );

    req.cvUploadMeta = {
      originalFileName,
      updatedFileName,
    };

    return {
      folder: 'careers/cv',
      resource_type: 'raw',
      // Include extension in public_id so Cloudinary stores the correct raw asset path.
      public_id: ext ? `${updatedBase}${ext}` : updatedBase,
    };
  },
});

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ];

  if (!allowedMimeTypes.includes(file.mimetype)) {
    return cb(new Error('Only PDF or Word documents are allowed'), false);
  }

  return cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});

module.exports = { upload };

