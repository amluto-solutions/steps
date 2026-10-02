// Checks a Tauri updater signature the way the app will, before a release is published
// (docs/spec/10-distribution.md#updates-for-the-exe). Tauri's keys and signatures are minisign
// files, base64-encoded once more:
//   public key: "untrusted comment: …\n" + base64("Ed" + key id (8) + Ed25519 key (32))
//   signature:  "untrusted comment: …\n" + base64("ED" + key id (8) + signature (64)) + "\n"
//               + "trusted comment: …\n" + base64(global signature (64)) + "\n"
// "ED" signs the file's BLAKE2b-512 hash; the global signature covers the file signature and the
// trusted comment, where the Tauri CLI records the version the file was signed for.
import { createHash, createPublicKey, verify } from "node:crypto";

const lines = (base64) =>
  Buffer.from(base64.trim(), "base64").toString("utf8").replace(/\r\n/g, "\n").split("\n");

/** The key id (hex, as minisign prints it) and the Ed25519 key of a Tauri public key. */
export function parsePublicKey(tauriPubkey) {
  const blob = Buffer.from(lines(tauriPubkey)[1] ?? "", "base64");
  if (blob.length !== 42 || blob.subarray(0, 2).toString("latin1") !== "Ed") {
    throw new Error("not a minisign Ed25519 public key");
  }
  return {
    keyId: Buffer.from(blob.subarray(2, 10)).reverse().toString("hex").toUpperCase(),
    key: createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: blob.subarray(10).toString("base64url") },
      format: "jwk",
    }),
  };
}

/**
 * Verifies `data` against a Tauri `.sig` and public key. Throws unless the key ids match and both
 * the file signature and the global signature (over the trusted comment) are good. Returns the
 * trusted comment.
 */
export function verifySignature(data, tauriSignature, tauriPubkey) {
  const { keyId, key } = parsePublicKey(tauriPubkey);
  const [, signatureLine, commentLine, globalLine] = lines(tauriSignature);
  const blob = Buffer.from(signatureLine ?? "", "base64");
  if (blob.length !== 74) throw new Error("not a minisign signature");
  const algorithm = blob.subarray(0, 2).toString("latin1");
  const signedBy = Buffer.from(blob.subarray(2, 10)).reverse().toString("hex").toUpperCase();
  if (signedBy !== keyId) throw new Error(`signed with key ${signedBy}, not ${keyId}`);
  const signature = blob.subarray(10);
  let message;
  if (algorithm === "ED") message = createHash("blake2b512").update(data).digest();
  else if (algorithm === "Ed") message = data;
  else throw new Error(`unknown signature algorithm ${algorithm}`);
  if (!verify(null, message, key, signature)) throw new Error("the file signature doesn't match");

  const prefix = "trusted comment: ";
  if (!commentLine?.startsWith(prefix)) throw new Error("the signature has no trusted comment");
  const comment = commentLine.slice(prefix.length);
  const global = Buffer.from(globalLine ?? "", "base64");
  if (!verify(null, Buffer.concat([signature, Buffer.from(comment, "utf8")]), key, global)) {
    throw new Error("the trusted comment's signature doesn't match");
  }
  return comment;
}

/** The version a trusted comment says the file was signed for (`…\tversion:1.2.3`), or null. */
export const signedVersion = (comment) =>
  comment
    .split("\t")
    .map((part) => /^version:(.+)$/.exec(part)?.[1])
    .find(Boolean) ?? null;
