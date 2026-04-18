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
#include <Preferences.h>
#include <Update.h>

#define SERVICE_UUID          "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d91"
#define LED_CHAR_UUID         "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d92"
#define WIFI_SCAN_CHAR_UUID   "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d93"
#define WIFI_JOIN_CHAR_UUID   "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d94"
#define WIFI_STATUS_CHAR_UUID "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d95"
#define OTA_DATA_CHAR_UUID    "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d96"
#define OTA_STATUS_CHAR_UUID  "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d97"
#define FW_INFO_CHAR_UUID     "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d98"

// Shared BLE OTA protocol (matches firmware/pi_robot/pi_robot.py):
//   ota-data   (write)    — binary frames with 1-byte opcode:
//       0x01 [size:u32 BE]   begin — reset buffer, expect `size` bytes
//       0x02 [payload]       chunk — append to flash
//       0x03                 commit — finalize OTA + restart
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

// OTA state — Update class handles flash writes into the inactive OTA slot.
bool otaInProgress = false;
size_t otaExpected = 0;
size_t otaReceived = 0;

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

class OtaDataCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* ch) override {
    String v = ch->getValue();
    if (v.length() == 0) return;
    uint8_t op = (uint8_t)v[0];
    if (op == 0x01) {
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
      delay(500);  // let the notify flush before the restart
      ESP.restart();
    }
  }
};

class LedCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* ch) override {
    String value = ch->getValue();
    if (value.length() > 0) applyLed(value[0] != 0);
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
  BLEService* service = server->createService(SERVICE_UUID);

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
