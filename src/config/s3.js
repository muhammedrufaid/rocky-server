const { S3Client } = require('@aws-sdk/client-s3');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

let s3Client;
let bucket;

function getS3Client() {
  if (!s3Client) {
    s3Client = new S3Client({
      region: requireEnv('AWS_REGION'),
      credentials: {
        accessKeyId: requireEnv('AWS_ACCESS_KEY_ID'),
        secretAccessKey: requireEnv('AWS_SECRET_ACCESS_KEY'),
      },
    });
  }

  return s3Client;
}

function getBucket() {
  if (!bucket) {
    bucket = requireEnv('AWS_S3_BUCKET');
  }

  return bucket;
}

function getRegion() {
  return requireEnv('AWS_REGION');
}

module.exports = {
  getS3Client,
  getBucket,
  getRegion,
};
