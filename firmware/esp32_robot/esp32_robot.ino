// Better Robotics — robot firmware
//
// Advertises a single BLE service that represents this robot. Each capability
// (LED, motors, sensors, ...) is a characteristic within that service. Today
// the only capability is the onboard LED; motors and sensors land as
// additional characteristics without changing the service UUID or the
// dashboard's connect flow.
//
// LED_PIN is the red LED on ESP32-CAM-MB (GPIO 33, active-low).
// Adjust for other boards.

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#define SERVICE_UUID  "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d91"
#define LED_CHAR_UUID "a5f7c4d2-1b8e-4b9a-9c3d-5e8a7b6c4d92"

const int LED_PIN = 33;

BLECharacteristic* ledChar = nullptr;
bool ledOn = false;

static void applyLed(bool on) {
  ledOn = on;
  digitalWrite(LED_PIN, on ? LOW : HIGH);  // active-low
  uint8_t v = on ? 1 : 0;
  if (ledChar) {
    ledChar->setValue(&v, 1);
    ledChar->notify();
  }
}

class LedCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* ch) override {
    String value = ch->getValue();
    if (value.length() > 0) applyLed(value[0] != 0);
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

  service->start();

  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();

  Serial.printf("\nAdvertising as %s\n", name);
  Serial.printf("Service  UUID: %s\n", SERVICE_UUID);
  Serial.printf("LED Char UUID: %s\n", LED_CHAR_UUID);
}

void loop() {
  delay(1000);
}
