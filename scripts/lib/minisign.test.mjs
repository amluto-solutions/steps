import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import { parsePublicKey, signedVersion, verifySignature } from "./minisign.mjs";

/** A minisign key pair and signer in Tauri's encoding, made here so no real key is needed. */
function keys(id = [1, 2, 3, 4, 5, 6, 7, 8]) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const keyId = Buffer.from(id);
  const pubkey = Buffer.from(
    `untrusted comment: minisign public key: TEST\n${Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64")}\n`,
  ).toString("base64");
  const signFile = (data, comment, algorithm = "ED") => {
    const message = algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data;
    const signature = sign(null, message, privateKey);
    const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
    const blob = Buffer.concat([Buffer.from(algorithm), keyId, signature]).toString("base64");
    return Buffer.from(
      `untrusted comment: signature from tauri secret key\n${blob}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`,
    ).toString("base64");
  };
  return { pubkey, signFile };
}

const setup = Buffer.from("pretend setup.exe");
const comment = "timestamp:1790000000\tfile:amluto-steps_0.2.0_x64-setup.exe\tversion:0.2.0";

describe("minisign signatures, as the updater checks them", () => {
  it("accepts the file it was made for, and reads the version it was signed for", () => {
    const { pubkey, signFile } = keys();
    expect(parsePublicKey(pubkey).keyId).toBe("0807060504030201");
    const trusted = verifySignature(setup, signFile(setup, comment), pubkey);
    expect(trusted).toBe(comment);
    expect(signedVersion(trusted)).toBe("0.2.0");
    // Legacy un-hashed signatures verify too.
    expect(() => verifySignature(setup, signFile(setup, comment, "Ed"), pubkey)).not.toThrow();
  });

  it("refuses a changed file, another key, or an edited trusted comment", () => {
    const { pubkey, signFile } = keys();
    const good = signFile(setup, comment);
    expect(() => verifySignature(Buffer.from("tampered"), good, pubkey)).toThrow(/doesn't match/);
    expect(() => verifySignature(setup, good, keys([9, 9, 9, 9, 9, 9, 9, 9]).pubkey)).toThrow(
      /signed with key/,
    );
    // Same key id, different key: the id matches but the signature can't.
    expect(() => verifySignature(setup, good, keys().pubkey)).toThrow(/doesn't match/);
    const text = Buffer.from(good, "base64").toString("utf8");
    const edited = Buffer.from(text.replace("version:0.2.0", "version:9.9.9")).toString("base64");
    expect(() => verifySignature(setup, edited, pubkey)).toThrow(/trusted comment/);
  });

  it("reads no version from a comment without one", () => {
    expect(signedVersion("timestamp:1\tfile:a.exe")).toBeNull();
  });
});
