#include "camera.h"

#include "esp_camera.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "camera";

// AI-Thinker ESP32-CAM pin map. If a board variant shows up, switch on
// an ifdef rather than patching in place.
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

// LEDC for the camera XCLK runs at 20 MHz on its own timer/channel —
// motors + flash own TIMER_0 / channels 0..4 at 1 kHz, so the camera
// must use a different channel/timer or it'd reconfigure their freq.
#define CAM_LEDC_CHANNEL  LEDC_CHANNEL_5
#define CAM_LEDC_TIMER    LEDC_TIMER_1

static bool s_present = false;
static int  s_init_error = 0;
static int  s_refcount = 0;
static SemaphoreHandle_t s_mutex = NULL;

bool camera_present(void)    { return s_present; }
int  camera_init_error(void) { return s_init_error; }

// One-shot hardware bring-up. Used by probe (boot detection) and by
// acquire on the 0→1 transition. Reapplies sensor settings every time
// since deinit/reinit cycles reset them.
static bool do_init(void) {
    bool psram = heap_caps_get_total_size(MALLOC_CAP_SPIRAM) > 0;

    camera_config_t cfg = {
        .pin_pwdn     = PWDN_GPIO_NUM,
        .pin_reset    = RESET_GPIO_NUM,
        .pin_xclk     = XCLK_GPIO_NUM,
        .pin_sccb_sda = SIOD_GPIO_NUM,
        .pin_sccb_scl = SIOC_GPIO_NUM,
        .pin_d7 = Y9_GPIO_NUM, .pin_d6 = Y8_GPIO_NUM,
        .pin_d5 = Y7_GPIO_NUM, .pin_d4 = Y6_GPIO_NUM,
        .pin_d3 = Y5_GPIO_NUM, .pin_d2 = Y4_GPIO_NUM,
        .pin_d1 = Y3_GPIO_NUM, .pin_d0 = Y2_GPIO_NUM,
        .pin_vsync = VSYNC_GPIO_NUM, .pin_href = HREF_GPIO_NUM,
        .pin_pclk  = PCLK_GPIO_NUM,
        .xclk_freq_hz = 20000000,
        .ledc_timer   = CAM_LEDC_TIMER,
        .ledc_channel = CAM_LEDC_CHANNEL,
        .pixel_format = PIXFORMAT_JPEG,
        .grab_mode    = CAMERA_GRAB_LATEST,
        .fb_location  = psram ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM,
        // QVGA 320×240 @ jpeg_quality 18: ~5–15 KB/frame from the
        // OV3660's HW JPEG encoder. Small enough that DTLS encryption
        // (the WebRTC bottleneck on classic ESP32) doesn't stall, and
        // OK on bandwidth for HTTP MJPEG. fb_count=2 lets the driver
        // capture frame N+1 while the pump sends N.
        .frame_size   = FRAMESIZE_QVGA,
        .jpeg_quality = 18,
        .fb_count     = psram ? 2 : 1,
    };

    esp_err_t err = esp_camera_init(&cfg);
    if (err != ESP_OK) {
        s_init_error = (int)err;
        ESP_LOGE(TAG, "init failed: 0x%x (psram=%d)", err, psram);
        return false;
    }
    s_init_error = 0;

    // vflip handles the AI-Thinker mounting quirk (camera connector exits
    // the module so the image is upside-down for a forward-facing robot).
    // hmirror OFF: operator looks through the robot's eyes, left-in-image
    // = left-in-world. set_aec2/set_gainceiling/set_awb_gain=1 break
    // OV2640 on this die; set_awb_gain(s, 0) keeps WB auto-mode on but
    // stops per-frame gain hunting.
    sensor_t *s = esp_camera_sensor_get();
    if (s) {
        s->set_vflip(s, 1);
        s->set_hmirror(s, 0);
        s->set_brightness(s, 1);
        s->set_saturation(s, 1);
        s->set_contrast(s, 1);
        s->set_sharpness(s, 1);
        s->set_awb_gain(s, 0);
    }
    return true;
}

bool camera_probe(void) {
    if (!s_mutex) s_mutex = xSemaphoreCreateMutex();
    if (!do_init()) {
        s_present = false;
        return false;
    }
    s_present = true;
    ESP_LOGI(TAG, "probe ok (qvga@q=18) — deinit until acquired");
    esp_camera_deinit();
    return true;
}

bool camera_acquire(void) {
    if (!s_present) return false;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (s_refcount == 0) {
        if (!do_init()) {
            xSemaphoreGive(s_mutex);
            return false;
        }
    }
    s_refcount++;
    int rc = s_refcount;
    xSemaphoreGive(s_mutex);
    ESP_LOGI(TAG, "acquired (refcount=%d)", rc);
    return true;
}

void camera_release(void) {
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (s_refcount > 0) {
        s_refcount--;
        int rc = s_refcount;
        if (s_refcount == 0) {
            esp_camera_deinit();
            ESP_LOGI(TAG, "released (refcount=0) — deinit, ~32 KB internal freed");
        } else {
            ESP_LOGI(TAG, "released (refcount=%d)", rc);
        }
    }
    xSemaphoreGive(s_mutex);
}
