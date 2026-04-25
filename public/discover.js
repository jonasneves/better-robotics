// Every connected client behind the same public IP shares one Lobby DO on
// the signal server and sees the same set of ads. Privacy: ads are visible
// to anyone behind the same NAT — treat them as hints, not credentials.
// Room IDs inside ads are still capabilities; trust comes from room-level
// auth, not from the discovery layer.

import { getMyPubkeyB64, signBytes, verifyBytes, canonical } from './peer-key.js';

const DEFAULT_SIGNAL_URL = 'https://signal.neevs.io';
const RECONNECT_BASE_MS  = 1500;
const RECONNECT_MAX_MS   = 30_000;
const HEARTBEAT_MS       = 20_000;
// Republish ads on this cadence so the server-side TTL never expires while
// we're still connected. Half of DEFAULT_AD_TTL with margin.
const REPUBLISH_MS       = 25_000;

// The signed-mode envelope: `_pubkey` and `_sig` get added to data; the
// signature covers canonical({id, data without _sig/_pubkey, pubkey}).
// `_pubkey` is base64url SPKI raw — the trust-store key consumers use.
async function _envelopeForPublish(id, data) {
  const pubkey = await getMyPubkeyB64();
  const bytes = new TextEncoder().encode(canonical({ id, data, pubkey }));
  const sig = await signBytes(bytes);
  return { ...data, _pubkey: pubkey, _sig: sig };
}

async function _verifyAd(ad) {
  const data = ad && ad.data;
  if (!data || !data._sig || !data._pubkey) return false;
  const { _sig, _pubkey, ...rest } = data;
  const bytes = new TextEncoder().encode(canonical({ id: ad.id, data: rest, pubkey: _pubkey }));
  return verifyBytes(bytes, _sig, _pubkey);
}

export class DiscoveryClient {
  constructor(opts) {
    opts = opts || {};
    const base = (opts.signalUrl || DEFAULT_SIGNAL_URL).replace(/^http/, 'ws');
    this._url = base + '/discover/ws';
    this._sign = !!opts.sign;
    this._ws = null;
    this._ads = [];
    this._listeners = new Set();
    this._myAds = new Map();          // id -> { data, ttl }
    this._reconnectDelay = RECONNECT_BASE_MS;
    this._reconnectTimer = null;
    this._heartbeatTimer = null;
    this._republishTimer = null;
    this._closed = false;
    this._connect();
  }

  _connect() {
    if (this._closed) return;
    try { this._ws = new WebSocket(this._url); }
    catch (err) { this._scheduleReconnect(); return; }

    this._ws.addEventListener('open', () => {
      this._reconnectDelay = RECONNECT_BASE_MS;
      // Re-publish anything we had before the disconnect — the server may
      // have lost our entries on close. _sendPublish handles the sign
      // wrap if signed mode is on.
      for (const [id, payload] of this._myAds) {
        this._sendPublish(id, payload.data, payload.ttl);
      }
      this._startHeartbeat();
      this._startRepublish();
    });

    this._ws.addEventListener('message', async (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type !== 'ads') return;
      const raw = Array.isArray(msg.ads) ? msg.ads : [];
      // In signed mode, drop ads with no signature or invalid signature.
      // Verification is async (Web Crypto), so we await — order preserved.
      let ads = raw;
      if (this._sign) {
        const checks = await Promise.all(raw.map(_verifyAd));
        ads = raw.filter((_, i) => checks[i]);
      }
      this._ads = ads;
      for (const fn of this._listeners) {
        try { fn(this._ads); } catch {}
      }
    });

    this._ws.addEventListener('close', () => {
      this._stopHeartbeat();
      this._stopRepublish();
      this._scheduleReconnect();
    });

    // Errors are followed by close which already reconnects. Empty handler
    // suppresses unhandled-error noise.
    this._ws.addEventListener('error', () => {});
  }

  _scheduleReconnect() {
    if (this._closed) return;
    if (this._reconnectTimer) return;
    const delay = this._reconnectDelay + Math.random() * 1000;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_MS);
      this._connect();
    }, delay);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (this._ws && this._ws.readyState === 1) {
        try { this._ws.send(JSON.stringify({ type: 'ping' })); } catch {}
      }
    }, HEARTBEAT_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
  }

  _startRepublish() {
    this._stopRepublish();
    this._republishTimer = setInterval(() => {
      if (!this._ws || this._ws.readyState !== 1) return;
      for (const [id, payload] of this._myAds) {
        this._sendPublish(id, payload.data, payload.ttl);
      }
    }, REPUBLISH_MS);
  }

  _stopRepublish() {
    if (this._republishTimer) { clearInterval(this._republishTimer); this._republishTimer = null; }
  }

  async _sendPublish(id, data, ttl) {
    if (!this._ws || this._ws.readyState !== 1) return;
    let payload = data;
    if (this._sign) {
      try { payload = await _envelopeForPublish(id, data); }
      catch { return; }  // signing failed — better to drop than send unsigned
      if (!this._ws || this._ws.readyState !== 1) return;
    }
    try { this._ws.send(JSON.stringify({ type: 'publish', id, data: payload, ttl })); } catch {}
  }

  // ── Public API ────────────────────────────────────────────────

  publish(id, data, ttlMs) {
    this._myAds.set(id, { data, ttl: ttlMs });
    this._sendPublish(id, data, ttlMs);
  }

  remove(id) {
    this._myAds.delete(id);
    if (this._ws && this._ws.readyState === 1) {
      try { this._ws.send(JSON.stringify({ type: 'remove', id })); } catch {}
    }
  }

  // Subscribe to ad-set changes. Fires immediately with the current snapshot.
  onChange(cb) {
    this._listeners.add(cb);
    try { cb(this._ads); } catch {}
    return () => this._listeners.delete(cb);
  }

  ads() { return this._ads.slice(); }

  close() {
    this._closed = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._stopHeartbeat();
    this._stopRepublish();
    if (this._ws) { try { this._ws.close(); } catch {} this._ws = null; }
    this._listeners.clear();
    this._myAds.clear();
  }
}

export function discover(opts) { return new DiscoveryClient(opts); }
