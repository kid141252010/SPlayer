import assert from "node:assert/strict";
import test from "node:test";
import { SharedRingBuffer } from "./SharedRingBuffer";

const IDX_WRITE = 0;
const IDX_READ = 1;
const IDX_EOF = 2;
const IDX_NOTIFY_COUNT = 3;

const getHeader = (ringBuffer: SharedRingBuffer) =>
  new Int32Array(ringBuffer.sharedArrayBuffer, 0, 4);

test("共享 seek 标记不会占用音频数据区", () => {
  const ringBuffer = SharedRingBuffer.create(8);

  assert.equal(ringBuffer.sharedArrayBuffer.byteLength, 28);
});

test("reset 会清空读写状态并唤醒等待中的读取者", () => {
  const ringBuffer = SharedRingBuffer.create(8);
  const header = getHeader(ringBuffer);

  ringBuffer.setEOF();
  const beforeNotifyCount = Atomics.load(header, IDX_NOTIFY_COUNT);

  ringBuffer.reset();

  assert.equal(Atomics.load(header, IDX_WRITE), 0);
  assert.equal(Atomics.load(header, IDX_READ), 0);
  assert.equal(Atomics.load(header, IDX_EOF), 0);
  assert.equal(Atomics.load(header, IDX_NOTIFY_COUNT), beforeNotifyCount + 1);
});

test("blockingRead 使用短超时降低 seek 等待延迟", () => {
  const ringBuffer = SharedRingBuffer.create(8);
  const header = getHeader(ringBuffer);
  const heap = new Uint8Array(8);
  const originalWait = Atomics.wait;
  const timeouts: (number | undefined)[] = [];

  Atomics.wait = ((typedArray, index, value, timeout) => {
    timeouts.push(timeout);
    Atomics.store(header, IDX_EOF, 1);
    return originalWait(typedArray, index, value, 0);
  }) as typeof Atomics.wait;

  try {
    assert.equal(ringBuffer.blockingRead(heap, 0, 1), 0);
  } finally {
    Atomics.wait = originalWait;
  }

  assert.deepEqual(timeouts, [100]);
});
