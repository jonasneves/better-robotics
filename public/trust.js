// Per-namespace trust store for paired peers.
//
// What "trust" means here: the user has previously accepted a pair
// request from a device with this pubkey (or bound it out-of-band via
// a QR), and chose to remember the relationship. Future requests from
// the same pubkey auto-accept silently. Same shape as Bluetooth's
// bonded-devices list or iOS's "Always allow" per-app permissions.
//
// Storage: localStorage under a namespace the caller picks
// (e.g. "myapp:trust:v1"). Cleared = lose all memory; future requests
// prompt again. Safe failure mode.
//
// Usage:
//   import { makeTrustStore } from './trust.js';
//   const trust = makeTrustStore('myapp:trust:v1');
//   if (trust.isAutoAccept(pubkey)) { ... }
//   trust.trust(pubkey, 'iPhone');

export function makeTrustStore(storageKey) {
  if (!storageKey || typeof storageKey !== 'string') {
    throw new Error('makeTrustStore: storageKey required');
  }

  function _load() {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }
  function _save(store) {
    try { localStorage.setItem(storageKey, JSON.stringify(store)); } catch {}
  }

  return {
    isTrusted(pubkey) {
      if (!pubkey) return false;
      return !!_load()[pubkey];
    },

    // Alias — semantic clarity at call sites. Trust today means auto-accept;
    // future revisions might split (e.g. trusted-but-prompt).
    isAutoAccept(pubkey) { return this.isTrusted(pubkey); },

    getTrust(pubkey) {
      if (!pubkey) return null;
      return _load()[pubkey] || null;
    },

    // Find an entry whose label matches — for "identity-changed" detection.
    findByLabel(label) {
      if (!label) return null;
      const store = _load();
      for (const [pubkey, meta] of Object.entries(store)) {
        if (meta && meta.label === label) return { pubkey, ...meta };
      }
      return null;
    },

    // Bind trust. Updates lastSeenAt on re-trust without resetting
    // firstPairedAt — the relationship is older than the reconfirmation.
    trust(pubkey, label) {
      if (!pubkey) return;
      const store = _load();
      const now = Date.now();
      const existing = store[pubkey];
      store[pubkey] = {
        label: label || (existing && existing.label) || 'Device',
        firstPairedAt: existing ? existing.firstPairedAt : now,
        lastSeenAt: now,
      };
      _save(store);
    },

    // Touch lastSeenAt without changing trust.
    touch(pubkey) {
      if (!pubkey) return;
      const store = _load();
      if (!store[pubkey]) return;
      store[pubkey].lastSeenAt = Date.now();
      _save(store);
    },

    untrust(pubkey) {
      if (!pubkey) return;
      const store = _load();
      delete store[pubkey];
      _save(store);
    },

    // Three-state classifier the UI can consume directly for "you've
    // connected before" / "first time" / "identity changed" hints.
    classify(ad) {
      const data = (ad && ad.data) || {};
      const pubkey = data._pubkey;
      const label  = data.label;
      if (!pubkey) return { state: 'unknown', pubkey: null, label, trust: null };
      if (this.isTrusted(pubkey)) {
        return { state: 'trusted', pubkey, label, trust: this.getTrust(pubkey) };
      }
      const byLabel = this.findByLabel(label);
      if (byLabel && byLabel.pubkey !== pubkey) {
        return { state: 'identity-changed', pubkey, label, trust: byLabel };
      }
      return { state: 'unknown', pubkey, label, trust: null };
    },
  };
}
