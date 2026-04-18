// Better Robotics — robot firmware
//
// Advertises a single BLE service. Each capability (LED, WiFi, motors,
// sensors, ...) is a characteristic within that service. The dashboard
// connects to Pi and ESP32 robots identically.
//
// LED_PIN is the red LED on ESP32-CAM-MB (GPIO 33, active-low). Adjust
// for other boards.

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <Update.h>
#include <mbedtls/sha256.h>

#define SERVICE_UUID          "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d91"
#define LED_CHAR_UUID         "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d92"
#define WIFI_SCAN_CHAR_UUID   "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d93"
#define WIFI_JOIN_CHAR_UUID   "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d94"
#define WIFI_STATUS_CHAR_UUID "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d95"
#define OTA_DATA_CHAR_UUID    "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d96"
#define OTA_STATUS_CHAR_UUID  "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d97"
#define FW_INFO_CHAR_UUID     "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d98"
#define MOTOR_CHAR_UUID       "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d99"

// Motors are safe-by-construction: every write resets a watchdog. If no write
// lands within MOTOR_WATCHDOG_MS, the robot reverts to (0, 0) on its own.
// This covers browser tab closes, operator out-of-range, anything that drops
// the BLE link — the failure mode you actually want when driving hardware.
const unsigned long MOTOR_WATCHDOG_MS = 500;

// Shared BLE OTA protocol (matches firmware/pi_robot/pi_robot.py):
//   ota-data   (write)    — binary frames with 1-byte opcode:
//       0x00                 abort — drop any in-flight Update state
//       0x01 [size:u32 BE]   begin-stream — reset, expect `size` bytes over BLE
//       0x02 [payload]       chunk — append to flash
//       0x03                 commit — finalize OTA + restart
//       0x04 [json]          fetch-url — payload is {"url":...,"size":N,"sha256":...}.
//                            ESP32 downloads the binary over WiFi (our own data
//                            plane once onboarded), verifies size + sha256, and
//                            commits. 20-60x faster than BLE streaming; dashboard
//                            prefers this path when wifi-status is joined.
//   ota-status (read+notify) — UTF-8 JSON: {"st":...,"n":...,"total":...,"err":...}
//   fw-info    (read)     — UTF-8 JSON: {"type":"esp32","url":"firmware/bins/esp32_robot.bin"}
// The dashboard reads fw-info to know where to fetch the update binary from.

// Shared BLE WiFi spec (matches firmware/pi_robot/pi_robot.py):
//   wifi-scan   — read + notify. UTF-8 JSON: [{"s":ssid,"r":0..100,"p":0|1}].
//                 Reading triggers a rescan; notify fires when done. Strongest first.
//   wifi-join   — write. UTF-8 JSON: {"s":ssid,"p":password}. Empty p for open nets.
//   wifi-status — read + notify. UTF-8 JSON: {"st":state,"ssid":name,"err":msg}.
//                 States: idle, joining, joined, failed. (Scan activity is
//                 tracked client-side via wifi-scan notifications; it doesn't
//                 change connection state.)

const int LED_PIN = 33;
const size_t SCAN_MAX = 10;

BLECharacteristic* ledChar        = nullptr;
BLECharacteristic* wifiScanChar   = nullptr;
BLECharacteristic* wifiJoinChar   = nullptr;
BLECharacteristic* wifiStatusChar = nullptr;
BLECharacteristic* otaDataChar    = nullptr;
BLECharacteristic* otaStatusChar  = nullptr;
BLECharacteristic* fwInfoChar     = nullptr;
BLECharacteristic* motorChar      = nullptr;

int8_t motorLeft = 0;
int8_t motorRight = 0;
unsigned long motorLastWriteAt = 0;

// OTA state — Update class handles flash writes into the inactive OTA slot.
bool otaInProgress = false;
size_t otaExpected = 0;
size_t otaReceived = 0;
// Restart is deferred out of the BLE write callback so the ATT response
// for the commit opcode (0x03) can actually be sent before we reboot.
// Restarting inline makes the client see "GATT operation failed" even
// though the flash commit succeeded.
volatile bool otaRestartPending = false;

Preferences prefs;

bool ledOn = false;

// WiFi state machine — non-blocking, polled from loop().
enum WifiPhase { PHASE_IDLE, PHASE_SCANNING, PHASE_JOINING };
WifiPhase wifiPhase = PHASE_IDLE;
String pendingSsid;
String pendingPass;
unsigned long joinStartedAt = 0;
const unsigned long JOIN_TIMEOUT_MS = 20000;

static String jsonEscape(const String& s) {
  String out; out.reserve(s.length() + 2);
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '"' || c == '\\') { out += '\\'; out += c; }
    else if (c == '\n')        { out += "\\n"; }
    else if (c == '\r')        { out += "\\r"; }
    else if ((uint8_t)c < 0x20){ /* drop control chars */ }
    else                       { out += c; }
  }
  return out;
}

static int rssiToStrength(int rssi) {
  // Clamp -100..-50 dBm → 0..100.
  int s = (rssi + 100) * 2;
  if (s < 0) s = 0;
  if (s > 100) s = 100;
  return s;
}

static void publishStatus(const char* st, const String& ssid = "", const String& err = "") {
  String payload = "{\"st\":\""; payload += st; payload += "\"";
  if (ssid.length()) { payload += ",\"ssid\":\""; payload += jsonEscape(ssid); payload += "\""; }
  if (err.length())  { payload += ",\"err\":\"";  payload += jsonEscape(err);  payload += "\""; }
  payload += "}";
  if (wifiStatusChar) {
    wifiStatusChar->setValue((uint8_t*)payload.c_str(), payload.length());
    wifiStatusChar->notify();
  }
  Serial.printf("wifi-status → %s\n", payload.c_str());
}

static void publishScan() {
  int n = WiFi.scanComplete();
  if (n < 0) n = 0;

  // Sort indices by RSSI (strongest first), cap at SCAN_MAX, dedupe by SSID.
  int idx[32];
  int count = min(n, 32);
  for (int i = 0; i < count; i++) idx[i] = i;
  for (int i = 0; i < count - 1; i++) {
    for (int j = i + 1; j < count; j++) {
      if (WiFi.RSSI(idx[j]) > WiFi.RSSI(idx[i])) { int t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
    }
  }

  String payload = "[";
  size_t emitted = 0;
  String seen;
  for (int k = 0; k < count && emitted < SCAN_MAX; k++) {
    String ssid = WiFi.SSID(idx[k]);
    if (ssid.length() == 0) continue;
    String key = "\x01" + ssid + "\x01";
    if (seen.indexOf(key) >= 0) continue;
    seen += key;
    int strength = rssiToStrength(WiFi.RSSI(idx[k]));
    int secured = (WiFi.encryptionType(idx[k]) == WIFI_AUTH_OPEN) ? 0 : 1;
    if (ssid.length() > 32) ssid = ssid.substring(0, 32);
    if (emitted) payload += ",";
    payload += "{\"s\":\""; payload += jsonEscape(ssid); payload += "\"";
    payload += ",\"r\":"; payload += strength;
    payload += ",\"p\":"; payload += secured;
    payload += "}";
    emitted++;
  }
  payload += "]";
  if (wifiScanChar) {
    wifiScanChar->setValue((uint8_t*)payload.c_str(), payload.length());
    wifiScanChar->notify();
  }
  WiFi.scanDelete();
}

static void startScan() {
  if (wifiPhase != PHASE_IDLE) return;
  WiFi.scanDelete();
  WiFi.scanNetworks(true);  // async; client knows it's scanning by having just
  wifiPhase = PHASE_SCANNING;  // triggered the read — notify fires when done.
}

static void startJoin(const String& ssid, const String& pass) {
  pendingSsid = ssid;
  pendingPass = pass;
  wifiPhase = PHASE_JOINING;
  joinStartedAt = millis();
  WiFi.disconnect(true, false);
  WiFi.begin(ssid.c_str(), pass.c_str());
  publishStatus("joining", ssid);
}

static void applyLed(bool on) {
  ledOn = on;
  digitalWrite(LED_PIN, on ? LOW : HIGH);  // active-low
  uint8_t v = on ? 1 : 0;
  if (ledChar) {
    ledChar->setValue(&v, 1);
    ledChar->notify();
  }
}

static void publishOta(const char* st, size_t n = 0, size_t total = 0, const char* err = nullptr) {
  String payload = "{\"st\":\""; payload += st; payload += "\"";
  payload += ",\"n\":"; payload += (unsigned)n;
  if (total) { payload += ",\"total\":"; payload += (unsigned)total; }
  if (err)   { payload += ",\"err\":\""; payload += err; payload += "\""; }
  payload += "}";
  if (otaStatusChar) {
    otaStatusChar->setValue((uint8_t*)payload.c_str(), payload.length());
    otaStatusChar->notify();
  }
  Serial.printf("ota-status → %s\n", payload.c_str());
}

// Parse 64-char hex SHA-256 digest into a 32-byte buffer. Returns false on bad input.
static bool parseHex32(const char* hex, size_t len, uint8_t out[32]) {
  if (len != 64) return false;
  for (int i = 0; i < 32; i++) {
    int hi = hex[2*i], lo = hex[2*i + 1];
    auto nib = [](int c) -> int {
      if (c >= '0' && c <= '9') return c - '0';
      if (c >= 'a' && c <= 'f') return c - 'a' + 10;
      if (c >= 'A' && c <= 'F') return c - 'A' + 10;
      return -1;
    };
    int h = nib(hi), l = nib(lo);
    if (h < 0 || l < 0) return false;
    out[i] = (h << 4) | l;
  }
  return true;
}

// Quick-and-dirty JSON field extractor — same lightweight approach as wifi-join.
static String extractJsonString(const String& doc, const char* key) {
  String needle = "\""; needle += key; needle += "\"";
  int k = doc.indexOf(needle);
  if (k < 0) return "";
  int colon = doc.indexOf(':', k);
  if (colon < 0) return "";
  int q1 = doc.indexOf('"', colon);
  if (q1 < 0) return "";
  int q2 = doc.indexOf('"', q1 + 1);
  while (q2 > 0 && doc[q2 - 1] == '\\') q2 = doc.indexOf('"', q2 + 1);
  if (q2 < 0) return "";
  return doc.substring(q1 + 1, q2);
}

static long extractJsonNumber(const String& doc, const char* key) {
  String needle = "\""; needle += key; needle += "\"";
  int k = doc.indexOf(needle);
  if (k < 0) return -1;
  int colon = doc.indexOf(':', k);
  if (colon < 0) return -1;
  int p = colon + 1;
  while (p < (int)doc.length() && (doc[p] == ' ' || doc[p] == '\t')) p++;
  long n = 0;
  bool any = false;
  while (p < (int)doc.length() && doc[p] >= '0' && doc[p] <= '9') {
    n = n * 10 + (doc[p] - '0');
    p++;
    any = true;
  }
  return any ? n : -1;
}

// Fetch the binary over WiFi, verify sha256 while streaming it into the OTA slot.
// Runs the whole download + verify + commit + restart inline.
static void otaFetchUrl(const String& url, size_t expectedSize, const uint8_t expectedHash[32]) {
  if (WiFi.status() != WL_CONNECTED) {
    publishOta("failed", 0, expectedSize, "wifi not connected");
    return;
  }
  WiFiClientSecure client;
  client.setInsecure();  // integrity is guaranteed by the sha256 check below
  HTTPClient http;
  if (!http.begin(client, url)) {
    publishOta("failed", 0, expectedSize, "http.begin failed");
    return;
  }
  int code = http.GET();
  if (code != HTTP_CODE_OK) {
    http.end();
    String err = "http "; err += code;
    publishOta("failed", 0, expectedSize, err.c_str());
    return;
  }
  if (!Update.begin(expectedSize)) {
    http.end();
    publishOta("failed", 0, expectedSize, "Update.begin failed");
    return;
  }

  mbedtls_sha256_context sha;
  mbedtls_sha256_init(&sha);
  mbedtls_sha256_starts(&sha, 0);

  WiFiClient* stream = http.getStreamPtr();
  uint8_t buf[2048];
  size_t total = 0;
  size_t lastReported = 0;
  unsigned long lastProgress = millis();
  unsigned long idleStart = millis();
  while (total < expectedSize) {
    size_t toRead = sizeof(buf);
    if (expectedSize - total < toRead) toRead = expectedSize - total;
    int got = stream->readBytes(buf, toRead);
    if (got == 0) {
      if (millis() - idleStart > 15000) {
        Update.abort();
        mbedtls_sha256_free(&sha);
        http.end();
        publishOta("failed", total, expectedSize, "stream stalled");
        return;
      }
      delay(10);
      continue;
    }
    idleStart = millis();
    size_t written = Update.write(buf, got);
    if (written != (size_t)got) {
      Update.abort();
      mbedtls_sha256_free(&sha);
      http.end();
      publishOta("failed", total, expectedSize, "Update.write short");
      return;
    }
    mbedtls_sha256_update(&sha, buf, got);
    total += got;
    // Rate-limit status notifies — every 32 KB is plenty for a seconds-long download.
    if (total - lastReported > 32768 || millis() - lastProgress > 250) {
      publishOta("receiving", total, expectedSize);
      lastReported = total;
      lastProgress = millis();
    }
  }
  http.end();

  uint8_t actualHash[32];
  mbedtls_sha256_finish(&sha, actualHash);
  mbedtls_sha256_free(&sha);
  if (memcmp(actualHash, expectedHash, 32) != 0) {
    Update.abort();
    publishOta("failed", total, expectedSize, "sha256 mismatch");
    return;
  }

  publishOta("committing", total, expectedSize);
  if (!Update.end(true)) {
    publishOta("failed", total, expectedSize, "Update.end failed");
    return;
  }
  publishOta("done", total, expectedSize);
  otaRestartPending = true;  // loop() restarts after the current callback returns
}

class OtaDataCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* ch) override {
    String v = ch->getValue();
    if (v.length() == 0) return;
    uint8_t op = (uint8_t)v[0];
    if (op == 0x00) {
      if (otaInProgress) {
        Update.abort();
        otaInProgress = false;
      }
      otaReceived = 0;
      otaExpected = 0;
      publishOta("idle");
    } else if (op == 0x01) {
      if (v.length() < 5) { publishOta("failed", 0, 0, "bad begin"); return; }
      otaExpected = ((uint32_t)(uint8_t)v[1] << 24)
                  | ((uint32_t)(uint8_t)v[2] << 16)
                  | ((uint32_t)(uint8_t)v[3] << 8)
                  |  (uint32_t)(uint8_t)v[4];
      otaReceived = 0;
      if (!Update.begin(otaExpected)) {
        publishOta("failed", 0, otaExpected, "Update.begin failed");
        return;
      }
      otaInProgress = true;
      publishOta("receiving", 0, otaExpected);
    } else if (op == 0x02) {
      if (!otaInProgress) { publishOta("failed", 0, 0, "no active session"); return; }
      size_t len = v.length() - 1;
      size_t w = Update.write((uint8_t*)(v.c_str() + 1), len);
      if (w != len) {
        Update.abort();
        otaInProgress = false;
        publishOta("failed", otaReceived, otaExpected, "write short");
        return;
      }
      otaReceived += len;
      publishOta("receiving", otaReceived, otaExpected);
    } else if (op == 0x03) {
      if (!otaInProgress) { publishOta("failed", 0, 0, "no active session"); return; }
      publishOta("committing", otaReceived, otaExpected);
      if (!Update.end(true)) {
        otaInProgress = false;
        publishOta("failed", otaReceived, otaExpected, "Update.end failed");
        return;
      }
      publishOta("done", otaReceived, otaExpected);
      otaRestartPending = true;  // loop() restarts after onWrite returns
    } else if (op == 0x04) {
      String payload = v.substring(1);
      String url = extractJsonString(payload, "url");
      long size = extractJsonNumber(payload, "size");
      String hashHex = extractJsonString(payload, "sha256");
      uint8_t expectedHash[32];
      if (url.length() == 0 || size <= 0 || !parseHex32(hashHex.c_str(), hashHex.length(), expectedHash)) {
        publishOta("failed", 0, 0, "bad fetch payload");
        return;
      }
      publishOta("fetching", 0, (size_t)size);
      otaFetchUrl(url, (size_t)size, expectedHash);
    }
  }
};

// ESP32's Arduino BLE library stops advertising when a central connects and
// doesn't auto-resume on disconnect — a 1:1-session default that makes the
// robot un-pair-able without a reboot. Restart advertising here so the
// behavior matches the Pi (BlueZ keeps advertising by default) and the
// operator can reconnect any time without power-cycling the device.
class ServerCallbacks : public BLEServerCallbacks {
  void onDisconnect(BLEServer* /*srv*/) override {
    BLEDevice::startAdvertising();
    Serial.println("client disconnected; advertising resumed");
  }
};

class LedCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* ch) override {
    String value = ch->getValue();
    if (value.length() > 0) applyLed(value[0] != 0);
  }
};

static void applyMotors(int8_t left, int8_t right) {
  motorLeft = left;
  motorRight = right;
  // Stub motor driver — wire your H-bridge / ledc PWM pins here. For now,
  // just reflect the commanded state over BLE and serial so the watchdog
  // behavior is visible end-to-end before any mechanical parts are wired.
  uint8_t buf[2] = { (uint8_t)left, (uint8_t)right };
  if (motorChar) {
    motorChar->setValue(buf, 2);
    motorChar->notify();
  }
  Serial.printf("motors → (%+d, %+d)\n", left, right);
}

class MotorCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* ch) override {
    String v = ch->getValue();
    if (v.length() < 2) return;
    motorLastWriteAt = millis();
    applyMotors((int8_t)v[0], (int8_t)v[1]);
  }
};

class WifiScanCallbacks : public BLECharacteristicCallbacks {
  void onRead(BLECharacteristic* /*ch*/) override { startScan(); }
};

class WifiJoinCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* ch) override {
    String value = ch->getValue();
    // Minimal JSON parse — spec is {"s":"...","p":"..."}. Anything else → failed.
    int sIdx = value.indexOf("\"s\"");
    int pIdx = value.indexOf("\"p\"");
    if (sIdx < 0) { publishStatus("failed", "", "missing ssid"); return; }
    auto extract = [&](int keyIdx) -> String {
      int colon = value.indexOf(':', keyIdx);
      if (colon < 0) return "";
      int q1 = value.indexOf('"', colon);
      if (q1 < 0) return "";
      int q2 = value.indexOf('"', q1 + 1);
      // Walk past escaped quotes.
      while (q2 > 0 && value[q2 - 1] == '\\') q2 = value.indexOf('"', q2 + 1);
      if (q2 < 0) return "";
      return value.substring(q1 + 1, q2);
    };
    String ssid = extract(sIdx);
    String pass = (pIdx >= 0) ? extract(pIdx) : "";
    if (ssid.length() == 0) { publishStatus("failed", "", "missing ssid"); return; }
    startJoin(ssid, pass);
  }
};

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, HIGH);  // off

  // Unique suffix from the chip's WiFi MAC (low 16 bits) — stable per device.
  uint64_t chipid = ESP.getEfuseMac();
  char name[32];
  snprintf(name, sizeof(name), "BetterRobot-%04X", (uint16_t)(chipid & 0xFFFF));

  // Put WiFi in STA mode but don't connect yet — we want BLE advertising up first.
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true, false);

  BLEDevice::init(name);
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  // Default numHandles is 15; every characteristic eats 2 handles (decl + val)
  // and every CCCD (2902) eats 1 more. This service needs 19 with current
  // characteristics — 32 leaves room for future ones without another silent
  // truncation. Exceeding the budget just drops chars past the cap without
  // reporting an error.
  BLEService* service = server->createService(BLEUUID(SERVICE_UUID), 32, 0);

  ledChar = service->createCharacteristic(
    LED_CHAR_UUID,
    BLECharacteristic::PROPERTY_READ
      | BLECharacteristic::PROPERTY_WRITE
      | BLECharacteristic::PROPERTY_NOTIFY
  );
  ledChar->addDescriptor(new BLE2902());
  ledChar->setCallbacks(new LedCallbacks());
  uint8_t initial = 0;
  ledChar->setValue(&initial, 1);

  wifiScanChar = service->createCharacteristic(
    WIFI_SCAN_CHAR_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  wifiScanChar->addDescriptor(new BLE2902());
  wifiScanChar->setCallbacks(new WifiScanCallbacks());
  wifiScanChar->setValue("[]");

  wifiJoinChar = service->createCharacteristic(
    WIFI_JOIN_CHAR_UUID,
    BLECharacteristic::PROPERTY_WRITE
  );
  wifiJoinChar->setCallbacks(new WifiJoinCallbacks());

  wifiStatusChar = service->createCharacteristic(
    WIFI_STATUS_CHAR_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  wifiStatusChar->addDescriptor(new BLE2902());
  wifiStatusChar->setValue("{\"st\":\"idle\"}");

  otaDataChar = service->createCharacteristic(
    OTA_DATA_CHAR_UUID,
    BLECharacteristic::PROPERTY_WRITE
  );
  otaDataChar->setCallbacks(new OtaDataCallbacks());

  otaStatusChar = service->createCharacteristic(
    OTA_STATUS_CHAR_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  otaStatusChar->addDescriptor(new BLE2902());
  otaStatusChar->setValue("{\"st\":\"idle\"}");

  fwInfoChar = service->createCharacteristic(
    FW_INFO_CHAR_UUID,
    BLECharacteristic::PROPERTY_READ
  );
  fwInfoChar->setValue("{\"type\":\"esp32\",\"url\":\"firmware/bins/esp32_robot.bin\"}");

  motorChar = service->createCharacteristic(
    MOTOR_CHAR_UUID,
    BLECharacteristic::PROPERTY_READ
      | BLECharacteristic::PROPERTY_WRITE
      | BLECharacteristic::PROPERTY_NOTIFY
  );
  motorChar->addDescriptor(new BLE2902());
  motorChar->setCallbacks(new MotorCallbacks());
  uint8_t motorInit[2] = { 0, 0 };
  motorChar->setValue(motorInit, 2);

  service->start();

  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();

  Serial.printf("\nAdvertising as %s\n", name);

  // If we previously joined a network, try it again silently in the background.
  prefs.begin("wifi", true);
  String savedSsid = prefs.getString("ssid", "");
  String savedPass = prefs.getString("pass", "");
  prefs.end();
  if (savedSsid.length()) {
    startJoin(savedSsid, savedPass);
  }
}

void loop() {
  // Deferred OTA restart — runs after the BLE write callback has returned
  // and the ATT response for opcode 0x03 has had a chance to go out. Restarting
  // inside the callback eats the response and the client thinks OTA failed.
  if (otaRestartPending) {
    delay(500);  // let the last notify + ATT response land
    ESP.restart();
  }

  // Motor watchdog — safe-default on disconnect. Commanded to non-zero and
  // silent for too long means the operator's gone; stop the hardware.
  if ((motorLeft != 0 || motorRight != 0)
      && motorLastWriteAt > 0
      && millis() - motorLastWriteAt > MOTOR_WATCHDOG_MS) {
    applyMotors(0, 0);
    Serial.printf("motor watchdog: stopped\n");
  }

  if (wifiPhase == PHASE_SCANNING) {
    int n = WiFi.scanComplete();
    if (n >= 0 || n == WIFI_SCAN_FAILED) {
      if (n >= 0) publishScan();
      wifiPhase = PHASE_IDLE;
    }
  } else if (wifiPhase == PHASE_JOINING) {
    wl_status_t s = WiFi.status();
    if (s == WL_CONNECTED) {
      wifiPhase = PHASE_IDLE;
      prefs.begin("wifi", false);
      prefs.putString("ssid", pendingSsid);
      prefs.putString("pass", pendingPass);
      prefs.end();
      publishStatus("joined", pendingSsid);
    } else if (s == WL_NO_SSID_AVAIL || s == WL_CONNECT_FAILED ||
               millis() - joinStartedAt > JOIN_TIMEOUT_MS) {
      wifiPhase = PHASE_IDLE;
      const char* err = (s == WL_NO_SSID_AVAIL) ? "ssid not found"
                      : (s == WL_CONNECT_FAILED) ? "connect failed"
                      : "timeout";
      WiFi.disconnect(true, false);
      publishStatus("failed", pendingSsid, err);
    }
  }
  delay(100);
}
