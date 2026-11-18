/** POSIX ustar, stored bytes: no application database or runtime is packaged. */
export function canvasArchive(
  entries: { path: string; bytes: Uint8Array }[],
): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    if (
      !/^[a-zA-Z0-9_./-]+$/u.test(entry.path) ||
      entry.path.length > 100 ||
      entry.path.split("/").includes("..")
    )
      throw new Error("导出文件名无效");
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    const octal = (value: number, offset: number, length: number) =>
      header.write(
        `${value.toString(8).padStart(length - 1, "0")}\0`,
        offset,
        length,
        "ascii",
      );
    octal(0o600, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(entry.bytes.byteLength, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    header.write("0", 156, 1);
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(
      `${checksum.toString(8).padStart(6, "0")}\0 `,
      148,
      8,
      "ascii",
    );
    chunks.push(
      header,
      entry.bytes,
      Buffer.alloc((512 - (entry.bytes.byteLength % 512)) % 512),
    );
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}
