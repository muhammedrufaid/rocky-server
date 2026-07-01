const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function getCredentials() {
  return {
    accessKeyId: requireEnv('AWS_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('AWS_SECRET_ACCESS_KEY'),
  };
}

let s3Client;
let bucket;
let resolvedRegion;
let regionPromise;

async function resolveBucketRegion() {
  if (resolvedRegion) {
    return resolvedRegion;
  }

  if (!regionPromise) {
    regionPromise = (async () => {
      const bucketName = requireEnv('AWS_S3_BUCKET');
      const configuredRegion = requireEnv('AWS_REGION');
      const probeClient = new S3Client({
        region: configuredRegion,
        credentials: getCredentials(),
      });

      try {
        await probeClient.send(new HeadBucketCommand({ Bucket: bucketName }));
        resolvedRegion = configuredRegion;
        return resolvedRegion;
      } catch (error) {
        const actualRegion = error?.$response?.headers?.['x-amz-bucket-region'];

        if (actualRegion) {
          resolvedRegion = actualRegion;
          return resolvedRegion;
        }

        throw error;
      }
    })();
  }

  return regionPromise;
}

async function getS3Client() {
  if (!s3Client) {
    const region = await resolveBucketRegion();
    s3Client = new S3Client({
      region,
      credentials: getCredentials(),
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

async function getRegion() {
  return resolveBucketRegion();
}

module.exports = {
  getS3Client,
  getBucket,
  getRegion,
};
