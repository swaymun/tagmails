// Encryption at rest for message content. Everything TagMails keeps that a
// person wrote or an agent answered (raw mail, results, files, reply payloads,
// subjects) is sealed with AES-256-GCM under STORAGE_KEY, a Worker secret.
// Nobody browsing R2 or D1 sees plaintext; reading it requires the secret.

import { createHash } from 'node:crypto';

const MAGIC = new TextEncoder().encode('TMENC1');
// Large files are sealed as a stream of 1 MiB AES-GCM records so neither the
// plaintext nor the ciphertext is ever whole in Worker memory.
const STREAM_MAGIC = new TextEncoder().encode('TMSTR1');
const RECORD = 1024 * 1024;
const TAG = 16;
const STREAM_HEADER = STREAM_MAGIC.length + 8;
const TEXT_PREFIX = 'enc:v1:';
const keys = new WeakMap();

async function storageKey(env) {
  if (!env.STORAGE_KEY) return null;
  if (!keys.has(env)) {
    const raw = Uint8Array.from(atob(env.STORAGE_KEY), (char) => char.charCodeAt(0));
    if (raw.length !== 32) throw new Error('STORAGE_KEY must be 32 bytes, base64 encoded');
    keys.set(env, crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
  }
  return keys.get(env);
}

async function toBytes(value) {
  if (value == null) return new Uint8Array();
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value.arrayBuffer === 'function') return new Uint8Array(await value.arrayBuffer());
  if (typeof value.getReader === 'function') return new Uint8Array(await new Response(value).arrayBuffer());
  throw new Error('Unsupported value for encrypted storage');
}

function sealed(bytes) {
  return bytes.length > MAGIC.length + 12 && MAGIC.every((byte, index) => bytes[index] === byte);
}

export async function encryptBytes(env, value) {
  const key = await storageKey(env);
  const plain = await toBytes(value);
  if (!key) return plain;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const out = new Uint8Array(MAGIC.length + iv.length + cipher.length);
  out.set(MAGIC, 0); out.set(iv, MAGIC.length); out.set(cipher, MAGIC.length + iv.length);
  return out;
}

export async function decryptBytes(env, value) {
  const bytes = await toBytes(value);
  if (!sealed(bytes)) return bytes; // Written before encryption was enabled.
  const key = await storageKey(env);
  if (!key) throw new Error('Encrypted storage needs STORAGE_KEY');
  const iv = bytes.subarray(MAGIC.length, MAGIC.length + 12);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, bytes.subarray(MAGIC.length + 12)));
}

function recordIv(base, index) {
  const iv = new Uint8Array(12);
  iv.set(base, 0);
  new DataView(iv.buffer).setUint32(8, index);
  return iv;
}

// The last record is marked in its additional data, so a truncated object
// fails to open instead of reading as a shorter file.
function recordData(last) { return new Uint8Array([last ? 1 : 0]); }

export function sealedStreamLength(plainLength) {
  return STREAM_HEADER + plainLength + TAG * Math.max(1, Math.ceil(plainLength / RECORD));
}

// Seals a plaintext stream of known length. With sha256, the stream errors at
// its end (aborting the R2 write) unless the plaintext matches.
export function sealStream(env, key, plain, plainLength, sha256 = null) {
  const base = crypto.getRandomValues(new Uint8Array(8));
  const hash = sha256 ? createHash('sha256') : null;
  let pending = new Uint8Array(0);
  let index = 0;
  let seen = 0;
  const seal = async (controller, chunk, last) => {
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: recordIv(base, index++), additionalData: recordData(last) }, key, chunk);
    controller.enqueue(new Uint8Array(cipher));
  };
  return plain.pipeThrough(new TransformStream({
    start(controller) {
      const header = new Uint8Array(STREAM_HEADER);
      header.set(STREAM_MAGIC, 0); header.set(base, STREAM_MAGIC.length);
      controller.enqueue(header);
    },
    async transform(chunk, controller) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      seen += bytes.length;
      if (seen > plainLength) throw new Error('File is longer than its declared length');
      hash?.update(bytes);
      const joined = new Uint8Array(pending.length + bytes.length);
      joined.set(pending, 0); joined.set(bytes, pending.length);
      let offset = 0;
      // Keep at least one full record back so the true last record is marked.
      while (joined.length - offset > RECORD) { await seal(controller, joined.subarray(offset, offset + RECORD), false); offset += RECORD; }
      pending = joined.slice(offset);
    },
    async flush(controller) {
      if (seen !== plainLength) throw new Error('File is shorter than its declared length');
      if (hash && hash.digest('hex') !== sha256) throw new Error('File hash does not match');
      await seal(controller, pending, true);
    },
  }));
}

function openStream(key, sealedBody) {
  let buffer = new Uint8Array(0);
  let base = null;
  let index = 0;
  const open = async (controller, record, last) => {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: recordIv(base, index++), additionalData: recordData(last) }, key, record);
    controller.enqueue(new Uint8Array(plain));
  };
  return sealedBody.pipeThrough(new TransformStream({
    async transform(chunk, controller) {
      const joined = new Uint8Array(buffer.length + chunk.length);
      joined.set(buffer, 0); joined.set(chunk, buffer.length);
      let offset = 0;
      if (!base) {
        if (joined.length < STREAM_HEADER) { buffer = joined; return; }
        base = joined.slice(STREAM_MAGIC.length, STREAM_HEADER);
        offset = STREAM_HEADER;
      }
      while (joined.length - offset > RECORD + TAG) { await open(controller, joined.subarray(offset, offset + RECORD + TAG), false); offset += RECORD + TAG; }
      buffer = joined.slice(offset);
    },
    async flush(controller) {
      if (!base) throw new Error('Sealed stream is truncated');
      await open(controller, buffer, true);
    },
  }));
}

const isStream = (value) => value && typeof value.getReader === 'function';

// An R2 bucket whose objects are sealed on put and opened on get. Callers keep
// using get(...).arrayBuffer() and .text() unchanged. A stream put with a
// known plaintext length ({ length }) is sealed record by record.
export function encryptedBucket(env, bucket) {
  if (!env.STORAGE_KEY || !bucket) return bucket;
  return {
    async put(key, value, options = {}) {
      if (isStream(value) && Number.isSafeInteger(options.length)) {
        const { length, sha256, ...rest } = options;
        const sealedLength = sealedStreamLength(length);
        let body = sealStream(env, await storageKey(env), value, length, sha256);
        if (typeof FixedLengthStream === 'function') body = body.pipeThrough(new FixedLengthStream(sealedLength));
        return bucket.put(key, body, { ...rest, customMetadata: { ...rest.customMetadata, sealed: 'stream-v1' } });
      }
      return bucket.put(key, await encryptBytes(env, value), options);
    },
    async get(key, options) {
      const object = await bucket.get(key, options);
      if (!object) return object;
      if (object.customMetadata?.sealed === 'stream-v1') {
        const cryptoKey = await storageKey(env);
        const body = () => openStream(cryptoKey, object.body);
        const whole = async () => new Uint8Array(await new Response(body()).arrayBuffer());
        return {
          key: object.key, etag: object.etag, uploaded: object.uploaded,
          httpMetadata: object.httpMetadata, customMetadata: object.customMetadata,
          get body() { return body(); },
          arrayBuffer: async () => (await whole()).buffer,
          text: async () => new TextDecoder().decode(await whole()),
          json: async () => JSON.parse(new TextDecoder().decode(await whole())),
        };
      }
      const plain = await decryptBytes(env, await object.arrayBuffer());
      // R2 objects expose their metadata through getters, so copy it explicitly.
      return {
        key: object.key, etag: object.etag, uploaded: object.uploaded,
        httpMetadata: object.httpMetadata, customMetadata: object.customMetadata,
        size: plain.byteLength,
        body: new Response(plain).body,
        arrayBuffer: async () => plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength),
        text: async () => new TextDecoder().decode(plain),
        json: async () => JSON.parse(new TextDecoder().decode(plain)),
      };
    },
    delete: (...args) => bucket.delete(...args),
    head: (...args) => bucket.head?.(...args),
    list: (...args) => bucket.list?.(...args),
  };
}

function base64(bytes) {
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}

export async function sealText(env, value) {
  if (value == null || !env.STORAGE_KEY) return value;
  return TEXT_PREFIX + base64(await encryptBytes(env, String(value)));
}

export async function openText(env, value) {
  if (typeof value !== 'string' || !value.startsWith(TEXT_PREFIX)) return value;
  const bytes = Uint8Array.from(atob(value.slice(TEXT_PREFIX.length)), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(await decryptBytes(env, bytes));
}

// Wrap the Worker env once per request so all storage goes through encryption.
export function protectedEnv(env) {
  if (!env.STORAGE_KEY || env.__protected) return env;
  return { ...env, MAIL: encryptedBucket(env, env.MAIL), __protected: true };
}
