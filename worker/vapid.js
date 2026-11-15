/* VAPID helpers. The private key is a Worker secret, never a file in git. */
import { buildPushHTTPRequest } from '@pushforge/builder';

let devJwk = null;

function b64urlToBytes(s) {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4 || 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Uncompressed P-256 public key (65 bytes) as base64url, for PushManager. */
export function publicKeyFromPrivateJwk(jwk) {
  const x = b64urlToBytes(jwk.x), y = b64urlToBytes(jwk.y);
  const raw = new Uint8Array(65);
  raw[0] = 4;
  raw.set(x, 1);
  raw.set(y, 33);
  return bytesToB64url(raw);
}

async function generateDevJwk() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { alg: 'ES256', ...jwk };
}

/**
 * Production reads VAPID_PRIVATE_KEY (a JSON JWK). Local dev (SATPASS_DEV=1)
 * mints a key for this process only. That key is not printed.
 */
export async function loadVapid(env) {
  if (env.VAPID_PRIVATE_KEY) {
    const jwk = typeof env.VAPID_PRIVATE_KEY === 'string' ? JSON.parse(env.VAPID_PRIVATE_KEY) : env.VAPID_PRIVATE_KEY;
    if (!jwk || !jwk.d || !jwk.x || !jwk.y) throw new Error('VAPID_PRIVATE_KEY is not a P-256 JWK');
    return { jwk, dev: false };
  }
  if (env.SATPASS_DEV !== '1') return null;
  if (!devJwk) {
    devJwk = await generateDevJwk();
    console.log('SatPass is using a process-local VAPID key because SATPASS_DEV=1 and VAPID_PRIVATE_KEY is unset.');
  }
  return { jwk: devJwk, dev: true };
}

export async function sendPush(env, subscription, payload) {
  const vapid = await loadVapid(env);
  if (!vapid) {
    const err = new Error('Push is not configured');
    err.status = 503;
    throw err;
  }
  const built = await buildPushHTTPRequest({
    privateJWK: vapid.jwk,
    subscription,
    message: {
      payload,
      adminContact: env.VAPID_SUBJECT || 'mailto:satpass@lukedw09.workers.dev',
      options: { ttl: 3600, urgency: 'high', topic: String(payload.tag || 'satpass').replace(/[^A-Za-z0-9]/g, '').slice(0, 32) || 'satpass' }
    }
  });
  const res = await fetch(built.endpoint, { method: 'POST', headers: built.headers, body: built.body });
  return res;
}
