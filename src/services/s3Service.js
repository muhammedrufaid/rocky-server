const {
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl: presignUrl } = require('@aws-sdk/s3-request-presigner');
const { getS3Client, getBucket, getRegion } = require('../config/s3');
const { isAllowedFolder, isPublicFolder } = require('../constants/s3');
const { generateUniqueFilename, buildS3Key } = require('../utils/fileUtils');

function assertValidFolder(folder) {
  if (!isAllowedFolder(folder)) {
    throw new Error(
      `Invalid S3 folder "${folder}". Allowed folders: images, videos, pdfs, cvs`
    );
  }
}

function assertUploadFile(file) {
  if (!file || !file.buffer) {
    throw new Error('A file buffer is required for upload');
  }
}

async function getFileUrl(key) {
  const bucket = getBucket();
  const region = await getRegion();
  const encodedKey = String(key)
    .split('/')
    .map(encodeURIComponent)
    .join('/');

  return `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;
}

async function uploadFile(file, folder) {
  assertUploadFile(file);
  assertValidFolder(folder);

  const fileName = generateUniqueFilename(file.originalname, file.mimetype);
  const key = buildS3Key(folder, fileName);
  const bucket = getBucket();
  const client = await getS3Client();

  const commandInput = {
    Bucket: bucket,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
  };

  await client.send(new PutObjectCommand(commandInput));

  const result = { key, fileName };

  if (isPublicFolder(folder)) {
    result.url = await getFileUrl(key);
  }

  return result;
}

async function getFileStream(key) {
  if (!key) {
    throw new Error('S3 object key is required');
  }

  const client = await getS3Client();
  const bucket = getBucket();

  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  return response;
}

async function deleteFile(key) {
  if (!key) {
    throw new Error('S3 object key is required for delete');
  }

  const client = await getS3Client();
  const bucket = getBucket();

  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  return { key };
}

async function getSignedUrl(key, options = {}) {
  if (!key) {
    throw new Error('S3 object key is required for signed URL');
  }

  const { expiresIn = 3600, downloadFileName } = options;
  const client = await getS3Client();
  const bucket = getBucket();

  const commandInput = {
    Bucket: bucket,
    Key: key,
  };

  if (downloadFileName) {
    commandInput.ResponseContentDisposition = `attachment; filename="${downloadFileName}"`;
  }

  const url = await presignUrl(client, new GetObjectCommand(commandInput), {
    expiresIn,
  });

  return { key, url, expiresIn };
}

module.exports = {
  uploadFile,
  deleteFile,
  getFileUrl,
  getSignedUrl,
  getFileStream,
};
