// Sealing to a paired computer's key. The relay seals what it stores (mail,
// results, subjects, held replies) to the X25519 public key the computer
// registered; only that computer's private key opens it. Shared by the Worker
// and the local adapters, so it uses WebCrypto only.
//
// Format: "TMDEV1" | label length (1) | label | key id (8) | ephemeral public
// key (32) | IV (12) | AES-256-GCM ciphertext. The AES key is HKDF-SHA256 of the
// X25519 shared secret (salt = ephemeral || recipient public key, info names
// the label); the header is the additional data, so a blob opens only under
// the label it was sealed for.

const MAGIC = new TextEncoder().encode('TMDEV1');
const INFO = 'tagmails device seal v1 ';
export const DEVICE_TEXT_PREFIX = 'dev:v1:';
export const SEAL_LABELS = Object.freeze(['request', 'attachment', 'result', 'subject', 'outbound']);
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;

const encoder = new TextEncoder();

function bytesOf(value) {
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error('Unsupported value for device sealing');
}

export function base64url(bytes) {
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(value) {
  const text = String(value).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(text + '='.repeat((4 - text.length % 4) % 4)), (char) => char.charCodeAt(0));
}

export function validPublicKey(value) {
  return typeof value === 'string' && PUBLIC_KEY.test(value) && fromBase64url(value).length === 32;
}

// A short, stable name for a public key: hex of the first 8 bytes of its SHA-256.
export async function keyIdFor(publicKey) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', fromBase64url(publicKey)));
  return [...digest.subarray(0, 8)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function aesKey(shared, ephemeral, recipient, label, usage) {
  const salt = new Uint8Array(64);
  salt.set(ephemeral, 0); salt.set(recipient, 32);
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(INFO + label) },
    material, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

function checkLabel(label) {
  if (!SEAL_LABELS.includes(label)) throw new Error('Unknown seal label');
}

export function isDeviceSealed(value) {
  if (!(value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value))) return false;
  const bytes = bytesOf(value);
  return bytes.length > MAGIC.length + 1 && MAGIC.every((byte, index) => bytes[index] === byte);
}

export function isDeviceSealedText(value) {
  return typeof value === 'string' && value.startsWith(DEVICE_TEXT_PREFIX);
}

export async function sealForDevice(publicKey, value, label) {
  checkLabel(label);
  if (!validPublicKey(publicKey)) throw new Error('Invalid device public key');
  const recipient = fromBase64url(publicKey);
  const keyId = new Uint8Array(await crypto.subtle.digest('SHA-256', recipient)).subarray(0, 8);
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const ephemeral = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const peer = await crypto.subtle.importKey('raw', recipient, { name: 'X25519' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'X25519', public: peer }, pair.privateKey, 256);
  const key = await aesKey(shared, ephemeral, recipient, label, 'encrypt');
  const labelBytes = encoder.encode(label);
  const header = new Uint8Array(MAGIC.length + 1 + labelBytes.length + 8 + 32);
  let offset = 0;
  header.set(MAGIC, offset); offset += MAGIC.length;
  header[offset] = labelBytes.length; offset += 1;
  header.set(labelBytes, offset); offset += labelBytes.length;
  header.set(keyId, offset); offset += 8;
  header.set(ephemeral, offset);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, key, bytesOf(value)));
  const out = new Uint8Array(header.length + iv.length + cipher.length);
  out.set(header, 0); out.set(iv, header.length); out.set(cipher, header.length + iv.length);
  return out;
}

function parse(bytes) {
  if (!isDeviceSealed(bytes)) throw new Error('Not a device-sealed value');
  let offset = MAGIC.length;
  const labelLength = bytes[offset]; offset += 1;
  const label = new TextDecoder().decode(bytes.subarray(offset, offset + labelLength)); offset += labelLength;
  const keyId = [...bytes.subarray(offset, offset + 8)].map((byte) => byte.toString(16).padStart(2, '0')).join(''); offset += 8;
  const ephemeral = bytes.subarray(offset, offset + 32); offset += 32;
  const header = bytes.subarray(0, offset);
  const iv = bytes.subarray(offset, offset + 12);
  const cipher = bytes.subarray(offset + 12);
  if (ephemeral.length !== 32 || iv.length !== 12 || cipher.length < 16) throw new Error('Device-sealed value is truncated');
  return { label, keyId, ephemeral, header, iv, cipher };
}

// The key id a sealed value names, without opening it.
export function sealedKeyId(value) {
  return parse(bytesOf(value)).keyId;
}

export async function sealTextForDevice(publicKey, text, label = 'subject') {
  return DEVICE_TEXT_PREFIX + base64url(await sealForDevice(publicKey, String(text), label));
}

// --- Device side -----------------------------------------------------------

export async function generateDeviceKey() {
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  return {
    version: 1,
    publicKey: base64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    privateKey: base64url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))),
  };
}

// Opens a sealed value with the device key ({ publicKey, privateKey } as saved
// by generateDeviceKey). Throws unless the value was sealed for `label`.
export async function openForDevice(deviceKey, value, label) {
  checkLabel(label);
  const sealed = parse(bytesOf(value));
  if (sealed.label !== label) throw new Error(`Expected a sealed ${label}, got ${sealed.label}`);
  if (sealed.keyId !== await keyIdFor(deviceKey.publicKey)) throw new Error('Sealed for a different device key');
  const privateKey = await crypto.subtle.importKey('pkcs8', fromBase64url(deviceKey.privateKey), { name: 'X25519' }, false, ['deriveBits']);
  const peer = await crypto.subtle.importKey('raw', sealed.ephemeral, { name: 'X25519' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'X25519', public: peer }, privateKey, 256);
  const key = await aesKey(shared, sealed.ephemeral, fromBase64url(deviceKey.publicKey), label, 'decrypt');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv, additionalData: sealed.header }, key, sealed.cipher));
}

export async function openTextForDevice(deviceKey, text, label = 'subject') {
  if (!isDeviceSealedText(text)) throw new Error('Not device-sealed text');
  return new TextDecoder().decode(await openForDevice(deviceKey, fromBase64url(text.slice(DEVICE_TEXT_PREFIX.length)), label));
}
