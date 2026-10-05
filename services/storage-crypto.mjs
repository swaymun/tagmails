// Encryption at rest for message content. Everything TagMails keeps that a
// person wrote or an agent answered (raw mail, results, files, reply payloads,
// subjects) is sealed with AES-256-GCM under STORAGE_KEY, a Worker secret.
// Nobody browsing R2 or D1 sees plaintext; reading it requires the secret.

const MAGIC = new TextEncoder().encode('TMENC1');
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

// An R2 bucket whose objects are sealed on put and opened on get. Callers keep
// using get(...).arrayBuffer() and .text() unchanged.
export function encryptedBucket(env, bucket) {
  if (!env.STORAGE_KEY || !bucket) return bucket;
  return {
    async put(key, value, options) { return bucket.put(key, await encryptBytes(env, value), options); },
    async get(key, options) {
      const object = await bucket.get(key, options);
      if (!object) return object;
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
