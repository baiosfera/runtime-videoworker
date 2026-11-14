import fs from "node:fs";
import path from "node:path";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

function cleanEnv(val, fallback = "") {
  const s = String(val || "").trim();
  return !s || (s.startsWith("${") && s.endsWith("}")) ? fallback : s;
}

export function getS3Config() {
  const endpoint = cleanEnv(process.env.S3_ENDPOINT);
  const accessKeyId = cleanEnv(process.env.S3_ACCESS_KEY);
  const secretAccessKey = cleanEnv(process.env.S3_SECRET_KEY);
  const bucket = cleanEnv(process.env.S3_BUCKET);
  const region = cleanEnv(process.env.S3_REGION, "us-east-1");
  return {
    configured: Boolean(endpoint && accessKeyId && secretAccessKey && bucket),
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    region,
  };
}

export function createS3Client(cfg = getS3Config()) {
  if (!cfg.configured) return null;
  return new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });
}

/**
 * Uploads a rendered MP4 file to Zerops Object Storage (S3 path-style) and verifies HeadObject.
 */
export async function uploadRenderToObjectStorage(localFilePath, objectKey) {
  const cfg = getS3Config();
  const body = fs.readFileSync(localFilePath);

  if (!cfg.configured) {
    const fallbackDir = "/tmp/videoworker-renders";
    fs.mkdirSync(fallbackDir, { recursive: true });
    const outPath = path.join(fallbackDir, path.basename(objectKey));
    fs.writeFileSync(outPath, body);
    return {
      storage: "local-tmp",
      key: objectKey,
      location: outPath,
      bytes: body.length,
    };
  }

  const client = createS3Client(cfg);
  await client.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: objectKey,
      Body: body,
      ContentType: "video/mp4",
    })
  );

  const head = await client.send(
    new HeadObjectCommand({
      Bucket: cfg.bucket,
      Key: objectKey,
    })
  );

  return {
    storage: "objectstorage",
    bucket: cfg.bucket,
    key: objectKey,
    location: `${cfg.endpoint.replace(/\/+$/, "")}/${cfg.bucket}/${objectKey}`,
    bytes: Number(head.ContentLength || body.length),
  };
}
