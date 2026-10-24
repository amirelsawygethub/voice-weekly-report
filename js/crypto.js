// AES-256-GCM encryption at rest. The key is generated on the device as a
// non-extractable CryptoKey, so scripts cannot read the raw key material.
import * as db from './db.js';

let keyPromise;

function getKey() {
  if (!keyPromise) {
    keyPromise = (async () => {
      const stored = await db.get('keys', 'master');
      // Accept any stored AES-GCM key object (an instanceof check can fail on a
      // valid key in some engines, and replacing the key would make every
      // saved note and setting unreadable).
      if (stored && stored.type === 'secret' && stored.algorithm && stored.algorithm.name === 'AES-GCM') return stored;
      if (stored && stored.jwk) {
        return crypto.subtle.importKey('jwk', stored.jwk, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      }
      if (stored) throw new Error('The encryption key on this device could not be read.');
      try {
        const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        await db.put('keys', key, 'master');
        return key;
      } catch {
        // Fallback for browsers that cannot store a CryptoKey in IndexedDB.
        const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
        const jwk = await crypto.subtle.exportKey('jwk', key);
        await db.put('keys', { jwk }, 'master');
        return crypto.subtle.importKey('jwk', jwk, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      }
    })();
    keyPromise = retryable(keyPromise);
  }
  return keyPromise;
}

export function resetKeyCache() { keyPromise = null; }

// Don't cache a failed key load; the next call tries again.
function retryable(p) {
  return p.catch(err => { keyPromise = null; throw err; });
}

export async function encryptBytes(buffer) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await getKey(), buffer);
  return { iv, data };
}

export async function decryptBytes({ iv, data }) {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await getKey(), data);
}

export async function encryptJSON(obj) {
  return encryptBytes(new TextEncoder().encode(JSON.stringify(obj)));
}

export async function decryptJSON(payload) {
  return JSON.parse(new TextDecoder().decode(await decryptBytes(payload)));
}
