// Per-WebRTC-session ECDSA P-256 self-signed cert generated in the browser
// and shipped to the chip over BLE before the DTLS handshake. Lets the
// chip drop mbedtls_ecp_gen_key + mbedtls_x509write_crt_* from the hot
// path (~100-200 ms saved on classic ESP32, ~3 KB of mbedTLS code that
// a future MBEDTLS_X509_CREATE_C=n build can strip entirely).
//
// Why dashboard-controlled cert: the wedge is "make the chip dumber".
// The cert is a per-session throwaway either way; running keygen in the
// browser frees the chip's mbedTLS context during init AND tightens the
// trust model (the dashboard, not the chip, decides what identity each
// session has — proximity-pair already authorized this dashboard).

// @peculiar/x509 self-signs an X.509 cert from a WebCrypto keypair without
// pulling Node crypto. Dynamic-imported so we pay the ~60 KB + asn1-schema
// dep only when WebRTC actually starts (cached by the SW after first run).
// Same CDN pattern as transformers.js / grounding.js.
const X509_URL = "https://cdn.jsdelivr.net/npm/@peculiar/x509@1.12.3/+esm";
let _x509 = null;

async function ensureX509Lib() {
  if (_x509) return _x509;
  _x509 = await import(/* @vite-ignore */ X509_URL);
  return _x509;
}

function derToPem(derBytes, label) {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(derBytes)));
  // PEM wraps base64 at 64 chars per line — RFC 1421. mbedtls_pk_parse_key
  // tolerates other widths but the chip's parser code is sensitive to
  // unexpected encodings on older builds; stay strict.
  const wrapped = b64.match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`;
}

// Returns { certPem, keyPem } as Uint8Arrays (UTF-8 of the PEM text), ready
// to feed the SIGNAL-char cert+key push. ~370 B total — under 4 BLE chunks.
//
// 1h validity is sized for the WebRTC session lifetime, not security: the
// cert is regenerated on every camera start, and the chip never persists
// it. A longer window would just confuse "is this cert still valid?"
// debugging without buying anything.
export async function generateSessionCert() {
  const x509 = await ensureX509Lib();
  const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const keys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=br-rtc",
    notBefore: new Date(now - 60_000),  // -1 min for clock skew
    notAfter:  new Date(now + 60 * 60_000),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    keys,
  });
  const certPem = cert.toString("pem");
  const keyDer = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
  const keyPem = derToPem(keyDer, "PRIVATE KEY");
  const enc = new TextEncoder();
  return { certPem: enc.encode(certPem), keyPem: enc.encode(keyPem) };
}
