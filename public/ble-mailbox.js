// BLE-relay alternative to signal.neevs.io's discover lobby. Wraps a
// connected PAIR_MAILBOX_CHAR_UUID into the same {publish, remove,
// onChange, close} surface DiscoveryClient exposes, so pair-request.js
// works identically over BLE without knowing about the transport.
//
// Wire envelope on the char (matches firmware/main/pair_mailbox.c):
//   0x01 [u16 BE total]  begin
//   0x02 [bytes]         chunk (≤ 100 B payload)
//   0x03                 commit
// The robot reassembles each writer's chunks, stores the full ad in a
// ring buffer, then re-emits the same chunked envelope to every other
// subscriber + replays the ring on subscribe.
//
// Sign mode mirrors discover.js: ads carry _pubkey + _sig over canonical({id, data, pubkey}).

import { getMyPubkeyB64, signBytes, verifyBytes, canonical } from './signal-sdk/v1/peer-key.js';

const BLE_CHUNK = 100;

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

// Wraps an already-connected, notify-enabled BluetoothRemoteGATTCharacteristic.
// Caller (app.js) is responsible for the BLE connection and char acquisition;
// this module just speaks the chunked envelope.
export class BleMailboxClient {
  constructor({ char, sign = true } = {}) {
    if (!char) throw new Error('BleMailboxClient: char required');
    this._char = char;
    this._sign = !!sign;
    // The lobby semantic is "set of currently-published ads"; the BLE
    // mailbox emits an event stream of received ads. We accumulate by
    // ad.id so the listener sees the same shape DiscoveryClient gives.
    this._ads = new Map();          // id → { id, data }
    this._listeners = new Set();
    this._myAds = new Map();        // id → { data }
    this._rxBuf = null;             // current chunked-rx buffer
    this._rxExpected = 0;
    this._rxGot = 0;
    this._closed = false;
    this._writeChain = Promise.resolve();  // serialize writes — chunk order matters
    this._onValueChanged = (e) => this._onNotify(e);
    char.addEventListener('characteristicvaluechanged', this._onValueChanged);
  }

  _onNotify(e) {
    if (this._closed) return;
    const dv = e.target.value;
    if (!dv || dv.byteLength === 0) return;
    const op = dv.getUint8(0);
    if (op === 0x01) {
      if (dv.byteLength < 3) { console.warn('[ble-mailbox] short begin frame'); return; }
      const total = dv.getUint16(1);
      console.log('[ble-mailbox] begin total=' + total);
      this._rxExpected = total;
      this._rxGot = 0;
      this._rxBuf = new Uint8Array(total);
      return;
    }
    if (op === 0x02) {
      if (!this._rxBuf) { console.warn('[ble-mailbox] chunk without begin'); return; }
      const payloadLen = dv.byteLength - 1;
      if (this._rxGot + payloadLen > this._rxExpected) {
        console.warn(`[ble-mailbox] chunk overflow ${this._rxGot}+${payloadLen} > ${this._rxExpected}`);
        this._rxBuf = null;
        return;
      }
      for (let i = 0; i < payloadLen; i++) {
        this._rxBuf[this._rxGot + i] = dv.getUint8(1 + i);
      }
      this._rxGot += payloadLen;
      return;
    }
    if (op === 0x03) {
      if (!this._rxBuf || this._rxGot !== this._rxExpected || this._rxGot === 0) {
        console.warn(`[ble-mailbox] commit mismatch buf=${!!this._rxBuf} got=${this._rxGot} expected=${this._rxExpected}`);
        this._rxBuf = null;
        return;
      }
      const text = new TextDecoder().decode(this._rxBuf);
      console.log('[ble-mailbox] commit ' + this._rxGot + 'B: ' + text.slice(0, 120));
      this._rxBuf = null;
      this._rxExpected = 0;
      this._rxGot = 0;
      let parsed;
      try { parsed = JSON.parse(text); } catch (err) { console.warn('[ble-mailbox] JSON parse failed:', err.message); return; }
      if (!parsed || !parsed.id || !parsed.data) { console.warn('[ble-mailbox] missing id/data', parsed); return; }
      const ad = { id: parsed.id, data: parsed.data };
      this._maybeAccept(ad);
    }
  }

  async _maybeAccept(ad) {
    if (this._sign) {
      const ok = await _verifyAd(ad).catch((err) => { console.warn('[ble-mailbox] verify threw:', err.message); return false; });
      if (!ok) { console.warn('[ble-mailbox] signature rejected for id=' + ad.id); return; }
    }
    if (this._closed) return;
    console.log('[ble-mailbox] accepted ad id=' + ad.id + ' app=' + (ad.data?.app || '?') + ' listeners=' + this._listeners.size);
    this._ads.set(ad.id, ad);
    const snapshot = [...this._ads.values()];
    for (const fn of this._listeners) {
      try { fn(snapshot); } catch (err) { console.warn('[ble-mailbox] listener threw:', err.message); }
    }
  }

  async _sendChunked(bytes) {
    const total = bytes.length;
    if (total === 0 || total > 0xFFFF) return;
    const begin = new Uint8Array(3);
    begin[0] = 0x01;
    begin[1] = (total >> 8) & 0xff;
    begin[2] = total & 0xff;
    await this._char.writeValueWithResponse(begin);
    for (let off = 0; off < total; off += BLE_CHUNK) {
      const take = Math.min(BLE_CHUNK, total - off);
      const buf = new Uint8Array(1 + take);
      buf[0] = 0x02;
      buf.set(bytes.subarray(off, off + take), 1);
      await this._char.writeValueWithResponse(buf);
    }
    await this._char.writeValueWithResponse(new Uint8Array([0x03]));
  }

  async _publishOnce(id, data) {
    if (this._closed) return;
    let payload = data;
    if (this._sign) {
      try { payload = await _envelopeForPublish(id, data); }
      catch { return; }
    }
    const wire = { id, data: payload };
    const bytes = new TextEncoder().encode(JSON.stringify(wire));
    try { await this._sendChunked(bytes); } catch { /* drop frame; next republish covers it */ }
  }

  // ── DiscoveryClient-shaped public API ────────────────────────────

  publish(id, data, _ttlMs) {
    this._myAds.set(id, { data });
    // Serialize so two publishes don't interleave their chunked writes
    // on the same characteristic.
    this._writeChain = this._writeChain.then(() => this._publishOnce(id, data));
    return this._writeChain;
  }

  // No real "remove" on the BLE relay (firmware ring ages out by depth,
  // not by id). Drop it from our local set so we won't be tempted to
  // republish on reconnect; consumers shouldn't rely on it being seen
  // by peers in real time.
  remove(id) {
    this._myAds.delete(id);
    this._ads.delete(id);
  }

  onChange(cb) {
    this._listeners.add(cb);
    try { cb([...this._ads.values()]); } catch {}
    return () => this._listeners.delete(cb);
  }

  ads() { return [...this._ads.values()]; }

  close() {
    this._closed = true;
    try { this._char.removeEventListener('characteristicvaluechanged', this._onValueChanged); } catch {}
    this._listeners.clear();
    this._ads.clear();
    this._myAds.clear();
  }
}

export function bleMailbox(opts) { return new BleMailboxClient(opts); }
