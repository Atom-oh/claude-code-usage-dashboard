import { closeSync, fstatSync, openSync, readSync } from "node:fs";

// Kubernetes projected secret volumes are symlinks; read the opened regular file.
// Never include a path or secret value in errors.
export function readSecret(env, name) {
  const file = env[`${name}_FILE`];
  if (file === undefined) return env[name];
  if (env[name] !== undefined) throw new Error(`${name} and ${name}_FILE cannot both be set`);
  let fd;
  try {
    if (!file) throw new Error();
    fd = openSync(file, "r");
    if (!fstatSync(fd).isFile()) throw new Error();
    const bytes = Buffer.alloc(65537);
    let length = 0, n;
    while (length < bytes.length && (n = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += n;
    if (!length || length > 65536) throw new Error();
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
  } catch {
    throw new Error(`${name}_FILE cannot be read as a non-empty secret`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
