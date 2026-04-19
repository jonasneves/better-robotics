// Better Robotics — robot firmware. Mirrors firmware/pi_robot/pi_robot.py.
// LED_PIN defaults to the red LED on ESP32-CAM-MB (GPIO 33, active-low).

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <WiFi.h>
#include <Preferences.h>
#include <Update.h>
#include "esp_camera.h"

// AI-Thinker ESP32-CAM pin map. Matches the OV2640/OV3660/OV5640 socket on
// the standard AI-Thinker board (the one paired with CAM-MB). If a future
// board variant shows up, switch on an ifdef rather than patching in place.
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

// UUIDs — must match firmware/pi_robot/pi_robot.py exactly.
#define SERVICE_UUID          "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d91"
#define LED_CHAR_UUID         "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d92"
#define WIFI_SCAN_CHAR_UUID   "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d93"
#define WIFI_JOIN_CHAR_UUID   "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d94"
#define WIFI_STATUS_CHAR_UUID "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d95"
#define OTA_DATA_CHAR_UUID    "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d96"
#define OTA_STATUS_CHAR_UUID  "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d97"
#define FW_INFO_CHAR_UUID     "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d98"
#define MOTOR_CHAR_UUID       "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d99"

// Motor watchdog: every write resets the timer; silence reverts to (0, 0).
// Safe default on disconnect — no redundant channel required.
const unsigned long MOTOR_WATCHDOG_MS = 500;

// Shared BLE OTA protocol (matches firmware/pi_robot/pi_robot.py):
//   ota-data   (write)    — binary frames with 1-byte opcode:
//       0x00                 abort — drop any in-flight Update state
//       0x01 [size:u32 BE]   begin-stream — reset, expect `size` bytes over BLE
//       0x02 [payload]       chunk — append to flash
//       0x03                 commit — finalize OTA + restart
//       0x04 [json]          fetch-url — accepted wire-wise, replies "failed"
//                            in this build. HTTPClient + NetworkClientSecure
//                            + mbedTLS were cut to fit IRAM once camera libs
//                            landed; dashboard's grace-window logic then falls
//                            back to BLE-stream OTA (slower, same result).
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

bool otaInProgress = false;
size_t otaExpected = 0;
size_t otaReceived = 0;
// Restart is deferred out of the BLE write callback so the ATT response
// for the commit opcode (0x03) can be sent before we reboot. Restarting
// inline makes the client see "GATT operation failed" even though the
// flash commit succeeded.
volatile bool otaRestartPending = false;

Preferences prefs;

bool ledOn = false;

static bool cameraReady = false;
static int  cameraInitError = 0;  // 0 if no init attempted or success
static TaskHandle_t streamTaskHandle = nullptr;

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
  // Map -100..-50 dBm → 0..100.
  int s = (rssi + 100) * 2;
  if (s < 0) s = 0;
  if (s > 100) s = 100;
  return s;
}

static void publishStatus(const char* st, const String& ssid = "", const String& err = "", const String& ip = "") {
  String payload = "{\"st\":\""; payload += st; payload += "\"";
  if (ssid.length()) { payload += ",\"ssid\":\""; payload += jsonEscape(ssid); payload += "\""; }
  if (err.length())  { payload += ",\"err\":\"";  payload += jsonEscape(err);  payload += "\""; }
  if (ip.length())   { payload += ",\"ip\":\"";   payload += ip;               payload += "\""; }
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

static bool initCamera() {
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk     = XCLK_GPIO_NUM;
  config.pin_pclk     = PCLK_GPIO_NUM;
  config.pin_vsync    = VSYNC_GPIO_NUM;
  config.pin_href     = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn     = PWDN_GPIO_NUM;
  config.pin_reset    = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size   = FRAMESIZE_VGA;   // 640×480 — generous headroom on PSRAM
  config.jpeg_quality = 12;              // lower = higher quality
  config.fb_count     = psramFound() ? 2 : 1;
  config.fb_location  = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  config.grab_mode    = CAMERA_GRAB_LATEST;
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    cameraInitError = (int)err;
    Serial.printf("camera init failed: 0x%x (psram=%d)\n", err, psramFound());
    return false;
  }
  Serial.printf("camera ok, psram=%d\n", psramFound());
  return true;
}

// MJPEG over HTTP — raw WiFiServer in a FreeRTOS task. Picked over
// esp_http_server because the latter's IRAM footprint pushed us 1952 B over
// iram0_0_seg. This variant only pulls in LwIP + JPEG dataflow (camera
// driver already resident) and holds up fine for classroom-distance streams.
static void streamTask(void* param) {
  WiFiServer server(81);
  server.begin();
  Serial.println("MJPEG task ready on :81/stream");
  while (true) {
    WiFiClient client = server.accept();
    if (!client) { vTaskDelay(50 / portTICK_PERIOD_MS); continue; }
    client.setNoDelay(true);
    // Drain request headers — we only serve /stream, so any GET is fine.
    unsigned long headerStart = millis();
    while (client.connected() && millis() - headerStart < 2000) {
      String line = client.readStringUntil('\n');
      if (line.length() <= 1) break;  // end of headers (blank line)
    }
    // CORS open so the dashboard on GitHub Pages can load the stream as <img>.
    client.print("HTTP/1.1 200 OK\r\n"
                 "Content-Type: multipart/x-mixed-replace;boundary=frame\r\n"
                 "Access-Control-Allow-Origin: *\r\n"
                 "Connection: close\r\n\r\n");
    while (client.connected()) {
      camera_fb_t *fb = esp_camera_fb_get();
      if (!fb) break;
      client.printf("\r\n--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n", fb->len);
      size_t written = client.write(fb->buf, fb->len);
      esp_camera_fb_return(fb);
      if (written != fb->len) break;  // client disconnected mid-frame
      vTaskDelay(1 / portTICK_PERIOD_MS);  // yield the core briefly
    }
    client.stop();
  }
}

static void startCameraServer() {
  if (streamTaskHandle) return;
  // Pin to core 1 — core 0 runs WiFi + BLE stacks; keep them uncontested.
  xTaskCreatePinnedToCore(streamTask, "mjpeg", 4096, nullptr, 1, &streamTaskHandle, 1);
}

static void publishFwInfo() {
  if (!fwInfoChar) return;
  // Always advertise the non-camera caps so the dashboard renders LED /
  // motors / wifi UI even when the camera failed to init. Each cap maps to
  // an existing BLE characteristic via the dashboard's UUIDS_BY_CAP table.
  String info = "{\"type\":\"esp32\",\"url\":\"firmware/bins/esp32_robot.bin\"";
  // `version` field matches the Pi's fw-info shape so the dashboard's menu
  // header renders it the same way for both platforms. Pi stamps a git SHA
  // in CI; ESP32 uses compile-time timestamp until CI learns to stamp.
  info += ",\"version\":\"" __DATE__ " " __TIME__ "\"";
  info += ",\"caps\":[";
  info += "{\"name\":\"led\",\"type\":\"toggle\"}";
  info += ",{\"name\":\"wifi\",\"type\":\"wifi-scan\"}";
  info += ",{\"name\":\"motors\",\"type\":\"signed-pair\",\"range\":[-100,100]}";
  if (cameraReady) {
    info += ",{\"name\":\"camera\",\"type\":\"mjpeg-stream\",\"port\":81,\"path\":\"/stream\"}";
  }
  info += "]";
  if (!cameraReady && cameraInitError) {
    info += ",\"camera_err\":";
    info += String(cameraInitError);
  }
  info += "}";
  fwInfoChar->setValue(info.c_str());
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
      // URL-trigger isn't in this build — HTTPClient + NetworkClientSecure +
      // mbedTLS were the cheapest IRAM cuts once camera libs joined, and BLE-
      // stream is the correct fallback. Replying "failed" tells the dashboard
      // to fall back automatically (see ota.js grace-window logic).
      publishOta("failed", 0, 0, "url-trigger unavailable in camera build");
    }
  }
};

// Arduino BLE stops advertising when a central connects and doesn't
// auto-resume on disconnect — restart it here so behavior matches the Pi
// (BlueZ keeps advertising by default) and the operator can reconnect
// without power-cycling the device.
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
  // Stub — wire your H-bridge / ledc PWM here. Current body just echoes
  // state over BLE so watchdog behavior is visible without hardware.
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
    // Payload spec: {"s":"...","p":"..."}.
    int sIdx = value.indexOf("\"s\"");
    int pIdx = value.indexOf("\"p\"");
    if (sIdx < 0) { publishStatus("failed", "", "missing ssid"); return; }
    auto extract = [&](int keyIdx) -> String {
      int colon = value.indexOf(':', keyIdx);
      if (colon < 0) return "";
      int q1 = value.indexOf('"', colon);
      if (q1 < 0) return "";
      int q2 = value.indexOf('"', q1 + 1);
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

  // Stable per-chip suffix — low 16 bits of the WiFi MAC.
  uint64_t chipid = ESP.getEfuseMac();
  char name[32];
  snprintf(name, sizeof(name), "BetterRobot-%04X", (uint16_t)(chipid & 0xFFFF));

  // STA mode without connecting — we want BLE advertising up first.
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true, false);

  BLEDevice::init(name);
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  // Default numHandles (15) silently drops characteristics past the cap.
  // Each characteristic = 2 handles (decl + val); each CCCD (2902) = 1 more.
  // 32 leaves room; exceeding the budget gives no error.
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
  // Initialize camera BEFORE publishing fw-info so the schema can report
  // whether the camera cap is available. Failure is non-fatal — robot still
  // functions as a BLE peripheral without camera.
  cameraReady = initCamera();
  publishFwInfo();

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

  prefs.begin("wifi", true);
  String savedSsid = prefs.getString("ssid", "");
  String savedPass = prefs.getString("pass", "");
  prefs.end();
  if (savedSsid.length()) {
    startJoin(savedSsid, savedPass);
  }
}

void loop() {
  if (otaRestartPending) {
    delay(500);  // let the last notify + ATT response land
    ESP.restart();
  }

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
      // IP is what the dashboard needs to open the MJPEG stream. Surface it
      // on wifi-status (notify) so a later-attached dashboard picks it up.
      publishStatus("joined", pendingSsid, "", WiFi.localIP().toString());
      if (cameraReady) startCameraServer();
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
