import { createHash, createHmac } from "node:crypto";

const encode = (value: string): string => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string): Buffer => createHmac("sha256", key).update(value).digest();

export interface S3Credentials { accessKey: string; secretKey: string; sessionToken?: string }

/** AWS SigV4 query authentication. URLs are ephemeral credentials: never log them. */
export function signS3Object(input: {
  bucket: string; region: string; key: string; method: "GET" | "PUT";
  credentials: S3Credentials; now: Date; expiresSeconds: number;
}): { url: string; headers: Record<string, string> } {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(input.bucket)
    || !/^[a-z]{2}-[a-z]+-\d$/.test(input.region)
    || !input.key || input.key.split("/").some(part => !part || part === "." || part === "..")
    || !input.credentials.accessKey || !input.credentials.secretKey
    || !Number.isInteger(input.expiresSeconds) || input.expiresSeconds < 1 || input.expiresSeconds > 604800) {
    throw new Error("invalid_cloud_storage_configuration");
  }
  const date = input.now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = date.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const host = input.region === "us-east-1" ? `${input.bucket}.s3.amazonaws.com` : `${input.bucket}.s3.${input.region}.amazonaws.com`;
  const path = `/${input.key.split("/").map(encode).join("/")}`;
  const headers: Record<string, string> = input.method === "PUT" ? { "if-none-match": "*" } : {};
  const signedHeaders = input.method === "PUT" ? "host;if-none-match" : "host";
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": `${input.credentials.accessKey}/${scope}`,
    "X-Amz-Date": date, "X-Amz-Expires": String(input.expiresSeconds), "X-Amz-SignedHeaders": signedHeaders,
  };
  if (input.credentials.sessionToken) query["X-Amz-Security-Token"] = input.credentials.sessionToken;
  const canonicalQuery = Object.entries(query).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");
  const canonicalHeaders = `host:${host}\n${input.method === "PUT" ? "if-none-match:*\n" : ""}`;
  const canonicalRequest = [input.method, path, canonicalQuery, canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.credentials.secretKey}`, day), input.region), "s3"), "aws4_request");
  const signature = hmac(signingKey, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha(canonicalRequest)}`).toString("hex");
  return { url: `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`, headers };
}
