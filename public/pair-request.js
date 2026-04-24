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
//   //       | { accepted: false, data: {} }
//   //       | { accepted: false, timedOut: true }
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
//     // Default: pass-through (every ad is considered for you). In
//     // practice consumers always pass a match fn.
//     match: (ad) => ad.data.target === myPubkey,
//   });

import { discover } from './discover.js';
import { getMyPubkeyB64 } from './peer-key.js';

const DEFAULT_REQUEST_TTL_MS = 30_000;
const DEFAULT_RESPONSE_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export function pairRequestClient({ app, sign = true, lobby = null } = {}) {
  if (!app || typeof app !== 'string') {
    throw new Error('pairRequestClient: app namespace required');
  }

  const REQUEST_APP  = app + '-request';
  const RESPONSE_APP = app + '-response';

  // Shared lobby across request and onRequest for this client. Consumer
  // may pass an existing lobby (their singleton) to avoid doubling WS
  // connections; otherwise we make our own.
  let _lobby = lobby;
  function _getLobby() { return _lobby || (_lobby = discover({ sign })); }

  let _myPubkey = null;
  async function _ensureMyPubkey() {
    if (!_myPubkey) _myPubkey = await getMyPubkeyB64();
    return _myPubkey;
  }

  // Pending requests we initiated, keyed by nonce. Resolver runs when the
  // matching response lands (or on timeout).
  const _pendingInitiations = new Map();

  // Nonces we've already handed to our onRequest handler, so the same
  // lobby broadcast replay doesn't double-fire.
  const _handledInboundNonces = new Set();

  let _responseSubscriptionActive = false;
  function _ensureResponseSubscription() {
    if (_responseSubscriptionActive) return;
    _responseSubscriptionActive = true;
    _getLobby().onChange((ads) => {
      if (!_myPubkey) return;  // can't match before we know our own pubkey
      for (const ad of ads || []) {
        const d = ad.data;
        if (!d || d.app !== RESPONSE_APP) continue;
        if (d.target !== _myPubkey) continue;
        const pending = _pendingInitiations.get(d.nonce);
        if (!pending) continue;
        _pendingInitiations.delete(d.nonce);
        clearTimeout(pending.timer);
        try { _getLobby().remove(REQUEST_APP + ':' + d.nonce); } catch {}
        const { accepted, target: _t, nonce: _n, app: _a, ...rest } = d;
        pending.resolve({ accepted: !!accepted, data: rest });
      }
    });
  }

  let _requestSubscriptionActive = false;
  function _ensureRequestSubscription(match, handler) {
    if (_requestSubscriptionActive) return;
    _requestSubscriptionActive = true;
    _getLobby().onChange((ads) => {
      for (const ad of ads || []) {
        const d = ad.data;
        if (!d || d.app !== REQUEST_APP) continue;
        if (!d.nonce || _handledInboundNonces.has(d.nonce)) continue;
        if (match && !match(ad)) continue;
        _handledInboundNonces.add(d.nonce);
        const senderPubkey = d._pubkey || null;  // from signed mode
        const { app: _a, nonce: _n, _pubkey: _p, _sig: _s, ...payload } = d;
        handler({
          senderPubkey,
          payload,
          accept: (responsePayload = {}) =>
            _publishResponse(true, senderPubkey, d.nonce, responsePayload),
          deny: (responsePayload = {}) =>
            _publishResponse(false, senderPubkey, d.nonce, responsePayload),
        });
      }
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

  // Publish a request and wait for the matching response.
  async function request({ payload = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    await _ensureMyPubkey();
    _ensureResponseSubscription();

    const nonce = (crypto.randomUUID && crypto.randomUUID()) ||
                  Math.random().toString(36).slice(2);

    const p = new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!_pendingInitiations.has(nonce)) return;
        _pendingInitiations.delete(nonce);
        try { _getLobby().remove(REQUEST_APP + ':' + nonce); } catch {}
        resolve({ accepted: false, timedOut: true, data: {} });
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
        pending.resolve({ accepted: false, timedOut: false, error: err, data: {} });
      }
    }
    return p;
  }

  // Subscribe to incoming requests. `handler` receives a req object with
  // senderPubkey, payload, and accept/deny methods. `match(ad)` decides
  // which requests are "for us" — default accepts all.
  function onRequest(handler, { match = null } = {}) {
    _ensureMyPubkey().catch(() => {});  // warm the pubkey cache
    _ensureRequestSubscription(match, handler);
  }

  return { request, onRequest };
}
