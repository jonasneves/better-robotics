#include "sdkconfig.h"
#if CONFIG_BALANCE_BOT_ENABLED

#include "sensors/imu.h"

#include <math.h>
#include <string.h>

#include "driver/i2c.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#if CONFIG_BALANCE_BOT_IMU_FILTER_COMPLEMENTARY
#include "complementary/complementary.h"
#else
#include "kalman/kalman.h"
#endif

static const char *TAG = "imu";

// MPU6050 register map (only what we need).
#define REG_PWR_MGMT_1   0x6B
#define REG_ACCEL_XOUT_H 0x3B   // start of 14-byte accel+temp+gyro block

// Full-scale ranges we configure at power-on defaults:
//   ±2g  → sensitivity 16384 LSB/g
//   ±250°/s → sensitivity 131 LSB/(°/s)
#define ACCEL_SCALE 16384.0f
#define GYRO_SCALE  131.0f

#define I2C_TIMEOUT_MS 10

static i2c_port_t s_port;
static uint8_t    s_addr;
static float      s_pitch = 0.0f;
static bool       s_ready = false;

#if CONFIG_BALANCE_BOT_IMU_FILTER_COMPLEMENTARY
static comp_filter_t s_filter;
#else
static kalman_angle_t *s_filter;
#endif

static esp_err_t mpu_write_reg(uint8_t reg, uint8_t val) {
    uint8_t buf[2] = {reg, val};
    return i2c_master_write_to_device(s_port, s_addr, buf, 2,
                                      pdMS_TO_TICKS(I2C_TIMEOUT_MS));
}

static esp_err_t mpu_read_regs(uint8_t reg, uint8_t *out, size_t len) {
    return i2c_master_write_read_device(s_port, s_addr, &reg, 1,
                                        out, len,
                                        pdMS_TO_TICKS(I2C_TIMEOUT_MS));
}

esp_err_t imu_init(i2c_port_t port, int sda_pin, int scl_pin, uint8_t addr) {
    s_port = port;
    s_addr = addr;

    i2c_config_t conf = {
        .mode             = I2C_MODE_MASTER,
        .sda_io_num       = sda_pin,
        .scl_io_num       = scl_pin,
        .sda_pullup_en    = GPIO_PULLUP_ENABLE,
        .scl_pullup_en    = GPIO_PULLUP_ENABLE,
        .master.clk_speed = 400000,
    };
    esp_err_t err = i2c_param_config(port, &conf);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2c_param_config: %s", esp_err_to_name(err));
        return err;
    }
    err = i2c_driver_install(port, I2C_MODE_MASTER, 0, 0, 0);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2c_driver_install: %s", esp_err_to_name(err));
        return err;
    }

    // Wake up — MPU6050 powers on in sleep mode.
    err = mpu_write_reg(REG_PWR_MGMT_1, 0x00);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "MPU6050 not responding at 0x%02x: %s",
                 addr, esp_err_to_name(err));
        return err;
    }
    vTaskDelay(pdMS_TO_TICKS(100));   // let sensor stabilize after wakeup

    // Seed the filter with a static accel reading so the first few loop
    // ticks don't snap from 0° to the real angle.
    float initial_pitch = 0.0f;
    uint8_t raw[6];
    if (mpu_read_regs(REG_ACCEL_XOUT_H, raw, 6) == ESP_OK) {
        int16_t ax = (int16_t)((raw[0] << 8) | raw[1]);
        int16_t az = (int16_t)((raw[4] << 8) | raw[5]);
        initial_pitch = atan2f(ax / ACCEL_SCALE, az / ACCEL_SCALE)
                      * (180.0f / (float)M_PI);
    }

#if CONFIG_BALANCE_BOT_IMU_FILTER_COMPLEMENTARY
    comp_filter_init(&s_filter,
        CONFIG_BALANCE_BOT_IMU_COMPLEMENTARY_ALPHA_PCT / 100.0f,
        initial_pitch);
#else
    s_filter = kalman_angle_create(
        CONFIG_BALANCE_BOT_IMU_KALMAN_Q_ANGLE_MILLI   / 1000.0f,
        CONFIG_BALANCE_BOT_IMU_KALMAN_Q_BIAS_MILLI    / 1000.0f,
        CONFIG_BALANCE_BOT_IMU_KALMAN_R_MEASURE_MILLI / 1000.0f);
    kalman_angle_reset(s_filter, initial_pitch);
#endif

    s_pitch = initial_pitch;
    s_ready = true;
    ESP_LOGI(TAG, "MPU6050 ready at 0x%02x — filter: %s, initial pitch %.2f°",
             addr,
#if CONFIG_BALANCE_BOT_IMU_FILTER_COMPLEMENTARY
             "complementary",
#else
             "kalman",
#endif
             s_pitch);
    return ESP_OK;
}

void imu_update(float dt_s) {
    if (!s_ready) return;

    // Read accel (bytes 0-5) + temp (bytes 6-7, skipped) + gyro (bytes 8-13)
    // in one burst from REG_ACCEL_XOUT_H.
    uint8_t raw[14];
    if (mpu_read_regs(REG_ACCEL_XOUT_H, raw, sizeof(raw)) != ESP_OK) return;

    int16_t ax_raw = (int16_t)((raw[0] << 8) | raw[1]);
    int16_t az_raw = (int16_t)((raw[4] << 8) | raw[5]);
    int16_t gy_raw = (int16_t)((raw[10] << 8) | raw[11]);  // pitch-axis gyro (Y)

    float ax_g        = ax_raw / ACCEL_SCALE;
    float az_g        = az_raw / ACCEL_SCALE;
    float gy_dps      = gy_raw / GYRO_SCALE;
    float accel_pitch = atan2f(ax_g, az_g) * (180.0f / (float)M_PI);

#if CONFIG_BALANCE_BOT_IMU_FILTER_COMPLEMENTARY
    s_pitch = comp_filter_update(&s_filter, gy_dps, accel_pitch, dt_s);
#else
    s_pitch = kalman_angle_update(s_filter, gy_dps, accel_pitch, dt_s);
#endif

#if CONFIG_BALANCE_BOT_IMU_PITCH_INVERT
    s_pitch = -s_pitch;
#endif
}

float imu_pitch_deg(void) { return s_pitch; }
bool  imu_ready(void)     { return s_ready; }

#endif // CONFIG_BALANCE_BOT_ENABLED
