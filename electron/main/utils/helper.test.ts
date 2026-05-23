import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { getFileID } from "./helper";

test("文件 ID 使用路径 MD5 字符串，保持与 Rust 扫描器一致", () => {
  const path = "D:/Music/song.flac";
  const expected = createHash("md5").update(path).digest("hex");

  assert.equal(getFileID(path), expected);
});
