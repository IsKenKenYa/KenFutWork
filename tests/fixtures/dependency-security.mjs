import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const requireRoot = createRequire(
  new URL("../../package.json", import.meta.url),
);
const requireServer = createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
);
const requireNut = createRequire(requireServer.resolve("@computer-use/nut-js"));
const requireJimp = createRequire(requireNut.resolve("jimp"));
const Jimp = requireNut("jimp");

async function checkFileType() {
  const requireCore = createRequire(requireJimp.resolve("@jimp/core"));
  const fileType = requireCore("file-type");
  const expected = { ext: "asf", mime: "application/vnd.ms-asf" };
  // ASF 的子对象头固定为 24 字节；0 会使旧解析器反复读取同一对象。
  for (const size of [0, 1, 23, 24, 25]) {
    const buffer = Buffer.alloc(55);
    Buffer.from("3026b2758e66cf11a6d9", "hex").copy(buffer);
    buffer.writeBigUInt64LE(BigInt(size), 46);
    if (size < 24) {
      await assert.rejects(fileType.fromBuffer(buffer), /Invalid ASF/);
    } else {
      assert.deepEqual(await fileType.fromBuffer(buffer), expected);
    }
  }
  const png = await new Jimp(2, 3, 0xff0000ff).getBufferAsync(Jimp.MIME_PNG);
  assert.deepEqual(await fileType.fromBuffer(png), {
    ext: "png",
    mime: "image/png",
  });
  const decoded = await Jimp.read(png);
  assert.equal(decoded.bitmap.width, 2);
  assert.equal(decoded.bitmap.height, 3);
  assert.equal(await fileType.fromBuffer(Buffer.alloc(0)), undefined);
}

function icns(entries) {
  const buffer = Buffer.alloc(8 + entries.length * 8);
  buffer.write("icns");
  buffer.writeUInt32BE(buffer.length, 4);
  entries.forEach((size, index) => {
    buffer.write(index === 0 ? "icp4" : "icp5", 8 + index * 8);
    buffer.writeUInt32BE(size, 12 + index * 8);
  });
  return buffer;
}

async function checkImageSize() {
  const requireAppdmg = createRequire(requireRoot.resolve("appdmg"));
  const sizeOf = requireAppdmg("image-size");
  for (const size of [0, 1, 7]) {
    assert.throws(() => sizeOf(icns([size])), /Invalid ICNS/);
    assert.throws(() => sizeOf(icns([8, size])), /Invalid ICNS/);
  }
  assert.equal(sizeOf(icns([8])).width, 16);
  assert.deepEqual(
    sizeOf(icns([8, 8])).images.map(({ width }) => width),
    [16, 32],
  );
  const png = await new Jimp(2, 3, 0xff0000ff).getBufferAsync(Jimp.MIME_PNG);
  assert.deepEqual(sizeOf(png), { width: 2, height: 3, type: "png" });
  const scratch = new URL("../../.scratch/", import.meta.url);
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(new URL("dependency-security-", scratch));
  try {
    const path = `${directory}/background.png`;
    await writeFile(path, png);
    assert.deepEqual(await promisify(sizeOf)(path), {
      width: 2,
      height: 3,
      type: "png",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function checkNodeForge() {
  const requireSandbox = createRequire(
    requireServer.resolve("@anthropic-ai/sandbox-runtime"),
  );
  const forge = requireSandbox("node-forge");
  const { privateKey: pem } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const privateKey = forge.pki.privateKeyFromPem(pem);
  const publicKey = forge.pki.rsa.setPublicKey(privateKey.n, privateKey.e);
  const md = forge.md.sha256.create().update("security regression");
  const digest = md.digest().bytes();
  assert.equal(publicKey.verify(digest, privateKey.sign(md)), true);
  const { asn1 } = forge;
  const sequence = (children) =>
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, children);
  for (const parameter of [false, true]) {
    const algorithm = [
      asn1.create(
        asn1.Class.UNIVERSAL,
        asn1.Type.OID,
        false,
        asn1.oidToDer(forge.pki.oids.sha256).getBytes(),
      ),
    ];
    if (parameter) {
      algorithm.push(
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ""),
      );
    }
    const makeDigestInfo = () =>
      asn1
        .toDer(
          sequence([
            sequence(algorithm),
            asn1.create(
              asn1.Class.UNIVERSAL,
              asn1.Type.OCTETSTRING,
              false,
              digest,
            ),
          ]),
        )
        .getBytes();
    const validSignature = privateKey.sign(makeDigestInfo(), "NONE");
    assert.equal(publicKey.verify(digest, validSignature), true);
    algorithm.push(
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, "extra"),
    );
    const invalidSignature = privateKey.sign(makeDigestInfo(), "NONE");
    assert.throws(
      () => publicKey.verify(digest, invalidSignature),
      /does not contain a valid RSASSA-PKCS1-v1_5 DigestInfo/,
    );
  }
}

const scenario = process.argv[2];
const checks = {
  "file-type": checkFileType,
  "image-size": checkImageSize,
  "node-forge": checkNodeForge,
};
assert.ok(Object.hasOwn(checks, scenario));
await checks[scenario]();
console.log(`${scenario}: ok`);
