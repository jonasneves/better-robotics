// Request/accept protocol over the /discover lobby.
//
// The pattern: one peer publishes a "pair-request" ad; another peer
// subscribed to the lobby filters for requests addressed to it, chooses
// whether to accept, and publishes a "pair-response" ad with the
// outcome. Nonces tie request and response; responses can carry an
// opaque payload (room id, grant token, whatever the consumer needs).
//
// This module is fully generic. Consumers pass an `app` namespace — the
// wire ad types become `<app>-request` and `<app>-response`. No product
// names here. Works identically for any consumer over any signal
// deployment. Signed mode (default) is recommended so the responder's
// trust decision can use a stable pubkey-per-device.
//
// Wire:
//   initiator → lobby: {
//     app:   "<ns>-request",
//     nonce: "<random>",
//     ...                   // any payload the consumer needs (roomCode,
//                           // target pubkey, label, peerId, etc.)
//   }
//   responder → lobby: {
//     app:      "<ns>-response",
//     target:   "<initiator-pubkey>",   // routes the response back
//     nonce:    "<same-nonce>",
//     accepted: true | false,
//     ...                                // opaque response payload
//   }
//
// Initiator usage:
//   const pr = pairRequestClient({ app: 'pip-pair' });
//   const result = await pr.request({
//     payload: { target: recipientPubkey, label: 'iPhone' },
//     timeoutMs: 30000
//   });
//   // result: { accepted: true,  data: { ... response payload ... } }
//   //       | { accepted: false, reason: 'denied',  data: { ... } }
//   //       | { accepted: false, reason: 'timeout' }
//   //       | { accepted: false, reason: 'error',   error: <Error> }
//   // (back-compat: `timedOut: true` aliases reason === 'timeout' for one revision)
//
// Responder usage:
//   const pr = pairRequestClient({ app: 'pip-pair' });
//   pr.onRequest(async (req) => {
//     // req: { senderPubkey, payload, accept(respPayload), deny(respPayload) }
//     if (trustStore.isAutoAccept(req.senderPubkey)) await req.accept({ roomId });
//     else {
//       const d = await showPrompt(req.payload.label);
//       if (d.accepted) await req.accept({ roomId });
//       else await req.deny();
//     }
//   }, {
//     // Optional predicate — which requests are "for me"? Consumers that
//     // target by pubkey use `ad.data.target === myPubkey`; consumers
//     // that target by room code use `ad.data.roomCode === myRoomCode`.
//     match: (ad) => ad.data.target === myPubkey,
//     // Optional error sink — fires when a handler throws. The library
//     // auto-denies the initiator so they don't hang, then calls this
//     // and re-raises to unhandledrejection. Wire this to your in-app
//     // log so handler errors don't vanish from the debug surface.
//     onError: (err, req) => log('pair-request handler: ' + err.message),
//   });

import { discover } from './discover.js';
import { getMyPubkeyB64 } from './peer-key.js';

const DEFAULT_REQUEST_TTL_MS = 30_000;
const DEFAULT_RESPONSE_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30_000;
// Upper bound on remembered-nonce set. Long-lived sessions (hours of
// dashboard open) would otherwise accumulate every nonce ever seen.
// When we hit the cap we drop the oldest half; dedup only needs to
// outlive the server's ad TTL (~30s-60s), so anything older is safe.
const MAX_HANDLED_NONCES = 1000;

export function pairRequestClient({ app, sign = true, lobby = null } = {}) {
  if (!app || typeof app !== 'string') {
    throw new Error('pairRequestClient: app namespace required');
  }

  const REQUEST_APP  = app + '-request';
  const RESPONSE_APP = app + '-response';

  let _lobby = lobby;
  function _getLobby() { return _lobby || (_lobby = discover({ sign })); }

  let _myPubkey = null;
  async function _ensureMyPubkey() {
    if (!_myPubkey) _myPubkey = await getMyPubkeyB64();
    return _myPubkey;
  }

  // Pending requests we initiated, keyed by nonce.
  const _pendingInitiations = new Map();

  // Nonces we've already handed to our onRequest handler — the same
  // lobby broadcast may replay on every change, so dedup by nonce. We
  // track order separately so we can drop the oldest half when we hit
  // MAX_HANDLED_NONCES.
  const _handledInboundNonces = new Set();
  const _handledInboundOrder = [];
  function _markHandled(nonce) {
    if (_handledInboundNonces.has(nonce)) return;
    _handledInboundNonces.add(nonce);
    _handledInboundOrder.push(nonce);
    if (_handledInboundOrder.length > MAX_HANDLED_NONCES) {
      const drop = _handledInboundOrder.splice(0, MAX_HANDLED_NONCES / 2);
      for (const n of drop) _handledInboundNonces.delete(n);
    }
  }

  // Request-listener state. onRequest can be called before we have our
  // pubkey; the subscription is wired lazily via _ensureSubscription.
  let _matchFn = null;
  let _handlerFn = null;
  let _errorFn = null;

  // Single lobby subscription dispatches both outgoing-response matches
  // (for pending initiations) and incoming-request matches (for the
  // registered handler). Keeps the lobby's onChange load to 1 callback
  // per client instead of 2.
  let _subscriptionActive = false;
  function _ensureSubscription() {
    if (_subscriptionActive) return;
    _subscriptionActive = true;
    _getLobby().onChange((ads) => {
      for (const ad of ads || []) {
        const d = ad.data;
        if (!d) continue;
        if (d.app === RESPONSE_APP) _dispatchResponse(ad);
        else if (d.app === REQUEST_APP) _dispatchRequest(ad);
      }
    });
  }

  function _dispatchResponse(ad) {
    const d = ad.data;
    if (!_myPubkey) return;
    if (d.target !== _myPubkey) return;
    const pending = _pendingInitiations.get(d.nonce);
    if (!pending) return;
    _pendingInitiations.delete(d.nonce);
    clearTimeout(pending.timer);
    try { _getLobby().remove(REQUEST_APP + ':' + d.nonce); } catch {}
    const { accepted, target: _t, nonce: _n, app: _a, ...rest } = d;
    if (accepted) pending.resolve({ accepted: true, data: rest });
    else pending.resolve({ accepted: false, reason: 'denied', data: rest });
  }

  function _dispatchRequest(ad) {
    const d = ad.data;
    if (!_handlerFn) return;
    if (!d.nonce || _handledInboundNonces.has(d.nonce)) return;
    if (_matchFn && !_matchFn(ad)) return;
    _markHandled(d.nonce);
    const senderPubkey = d._pubkey || null;
    const { app: _a, nonce: _n, _pubkey: _p, _sig: _s, ...payload } = d;
    const req = {
      senderPubkey,
      payload,
      accept: (responsePayload = {}) =>
        _publishResponse(true, senderPubkey, d.nonce, responsePayload),
      deny: (responsePayload = {}) =>
        _publishResponse(false, senderPubkey, d.nonce, responsePayload),
    };
    // Wrap so a thrown/rejected handler doesn't break the listener or
    // leave the initiator hanging.
    Promise.resolve()
      .then(() => _handlerFn(req))
      .catch((err) => {
        try { _publishResponse(false, senderPubkey, d.nonce, { reason: 'error' }); } catch {}
        // Surface to the consumer's log surface if they supplied one —
        // unhandledrejection still fires below for browser telemetry.
        if (_errorFn) { try { _errorFn(err, req); } catch {} }
        Promise.reject(err);
      });
  }

  function _publishResponse(accepted, targetPubkey, nonce, payload) {
    const data = {
      app: RESPONSE_APP,
      target: targetPubkey,
      nonce,
      accepted: !!accepted,
      ...payload,
    };
    return _getLobby().publish(RESPONSE_APP + ':' + nonce, data, DEFAULT_RESPONSE_TTL_MS);
  }

  // ── Public API ────────────────────────────────────────────────

  async function request({ payload = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    await _ensureMyPubkey();
    _ensureSubscription();

    const nonce = (crypto.randomUUID && crypto.randomUUID()) ||
                  Math.random().toString(36).slice(2);

    const p = new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!_pendingInitiations.has(nonce)) return;
        _pendingInitiations.delete(nonce);
        try { _getLobby().remove(REQUEST_APP + ':' + nonce); } catch {}
        resolve({ accepted: false, reason: 'timeout', timedOut: true });
      }, timeoutMs);
      _pendingInitiations.set(nonce, { resolve, timer });
    });

    try {
      await _getLobby().publish(REQUEST_APP + ':' + nonce, {
        app: REQUEST_APP,
        nonce,
        ...payload,
      }, DEFAULT_REQUEST_TTL_MS);
    } catch (err) {
      const pending = _pendingInitiations.get(nonce);
      if (pending) {
        _pendingInitiations.delete(nonce);
        clearTimeout(pending.timer);
        pending.resolve({ accepted: false, reason: 'error', error: err });
      }
    }
    return p;
  }

  // Register the incoming-request handler. Calling twice replaces the
  // handler (and its match/onError); intentional — consumers that rebuild
  // their UI can re-wire without leaking subscriptions.
  function onRequest(handler, { match = null, onError = null } = {}) {
    _ensureMyPubkey().catch(() => {});
    _matchFn = match;
    _handlerFn = handler;
    _errorFn = onError;
    _ensureSubscription();
  }

  return { request, onRequest };
}
