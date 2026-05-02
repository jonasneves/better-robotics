#include "camera.h"

#include <string.h>

#include "esp_camera.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "nvs.h"

#include "restart_util.h"

static const char *TAG = "camera";

// AI-Thinker ESP32-CAM pin map — same as the .ino. If a board variant
// shows up, switch on an ifdef rather than patching in place.
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

static bool s_ready = false;
static int  s_init_error = 0;
static camera_profile_t s_profile = CAM_PROFILE_COMPACT;

static bool psram_present(void) {
    return heap_caps_get_total_size(MALLOC_CAP_SPIRAM) > 0;
}

const char *camera_profile_name(camera_profile_t p) {
    switch (p) {
        case CAM_PROFILE_COMPACT:  return "compact";
        case CAM_PROFILE_STANDARD: return "standard";
        case CAM_PROFILE_FULL:     return "full";
    }
    return "standard";
}

camera_profile_t camera_profile_from_name(const char *name) {
    if (name && strcmp(name, "compact") == 0) return CAM_PROFILE_COMPACT;
    if (name && strcmp(name, "full")    == 0) return CAM_PROFILE_FULL;
    return CAM_PROFILE_STANDARD;
}

bool camera_ready(void)            { return s_ready; }
int  camera_init_error(void)       { return s_init_error; }
camera_profile_t camera_get_profile(void) { return s_profile; }

bool camera_init(void) {
    nvs_handle_t h;
    if (nvs_open("cam", NVS_READONLY, &h) == ESP_OK) {
        int32_t p;
        if (nvs_get_i32(h, "profile", &p) == ESP_OK) {
            s_profile = (camera_profile_t)p;
        }
        nvs_close(h);
    }

    bool psram = psram_present();

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
    };
    // Profile-driven framesize / quality. fb_count stays 1 for compact;
    // standard/full use 2 when PSRAM is present so the driver can capture
    // frame N+1 while the stream task transmits frame N — single-buffer
    // with GRAB_LATEST forces a full capture round-trip per fb_get(),
    // causing visible 100-200 ms hitches.
    // jpeg_quality numbers are inverted (higher = more compression =
    // smaller file). Bumped one notch from the prior 15/12/10 baseline:
    // shorter TX bursts on classic ESP32 give BLE coex more breathing
    // room without visibly hurting the stream at QVGA/VGA sizes.
    switch (s_profile) {
        case CAM_PROFILE_COMPACT:
            cfg.frame_size = FRAMESIZE_QVGA;
            cfg.jpeg_quality = 18;
            // fb_count=2 with PSRAM lets the driver capture frame N+1
            // while the pump is still sending N. Bumped from 1 because
            // QVGA frames (~5-15kB) easily fit two in PSRAM and the
            // overlap roughly halves per-frame latency on the camera
            // path. Falls back to 1 when no PSRAM (rare on ESP32-CAM).
            cfg.fb_count = psram ? 2 : 1;
            break;
        case CAM_PROFILE_FULL:
            cfg.frame_size = FRAMESIZE_SVGA;
            cfg.jpeg_quality = 12;
            cfg.fb_count = psram ? 2 : 1;
            break;
        case CAM_PROFILE_STANDARD:
        default:
            cfg.frame_size = FRAMESIZE_VGA;
            cfg.jpeg_quality = 14;
            cfg.fb_count = psram ? 2 : 1;
            break;
    }

    esp_err_t err = esp_camera_init(&cfg);
    if (err != ESP_OK) {
        s_init_error = (int)err;
        ESP_LOGE(TAG, "init failed: 0x%x (psram=%d, profile=%s)",
                 err, psram, camera_profile_name(s_profile));
        return false;
    }
    ESP_LOGI(TAG, "ok, psram=%d, profile=%s", psram, camera_profile_name(s_profile));

    // Sensor tuning — vflip handles the AI-Thinker mounting quirk
    // (camera connector exits the module so the image is upside-down for
    // a robot pointing forward). hmirror stays OFF: the operator looks
    // through the robot's eyes at the world, so left-in-image = left-in-
    // world. Brightness/saturation/contrast/sharpness are post-DSP knobs;
    // factory defaults read flat indoors. AEC pipeline tweaks
    // (set_aec2/set_gainceiling/set_awb_gain=1) broke OV2640 on this die
    // earlier — stay reverted. set_awb_gain(s, 0) is the inverse and
    // safe: keeps WB auto-mode ON but stops per-frame gain hunting.
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
    s_ready = true;
    return true;
}

void camera_handle_profile_write(const uint8_t *json, size_t len) {
    // Tiny extractor — find "profile":"name". Same shape as the .ino's
    // CameraProfileCallbacks logic, just inlined.
    static const char needle[] = "\"profile\"";
    const char *p = (const char *)json;
    const char *end = p + len;
    const char *q = NULL;
    for (const char *i = p; i + sizeof(needle) - 1 <= end; i++) {
        if (memcmp(i, needle, sizeof(needle) - 1) == 0) { q = i + sizeof(needle) - 1; break; }
    }
    if (!q) { ESP_LOGW(TAG, "bad payload"); return; }
    while (q < end && (*q == ' ' || *q == '\t' || *q == ':')) q++;
    if (q >= end || *q != '"') { ESP_LOGW(TAG, "bad payload"); return; }
    q++;
    char value[16] = {0};
    int n = 0;
    while (q < end && *q != '"' && n < (int)sizeof(value) - 1) value[n++] = *q++;
    value[n] = 0;

    camera_profile_t next = camera_profile_from_name(value);
    if (next == s_profile) {
        ESP_LOGI(TAG, "already %s, no-op", value);
        return;
    }
    nvs_handle_t h;
    if (nvs_open("cam", NVS_READWRITE, &h) != ESP_OK) return;
    nvs_set_i32(h, "profile", (int32_t)next);
    nvs_commit(h);
    nvs_close(h);
    ESP_LOGI(TAG, "%s → %s, restarting", camera_profile_name(s_profile), value);
    schedule_restart(500);
}
