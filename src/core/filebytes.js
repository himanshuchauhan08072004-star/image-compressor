const cache = new WeakMap();
/** Read a File fully once and reuse the bytes while the same File object lives. */
export function readFileBytes(file) {
  if (!cache.has(file)) cache.set(file, file.arrayBuffer().then((ab) => new Uint8Array(ab)));
  return cache.get(file);
}
