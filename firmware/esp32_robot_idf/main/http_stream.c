#include "http_stream.h"

#include <stdio.h>
#include <string.h>

#include "esp_camera.h"
#include "esp_http_server.h"
#include "esp_log.h"

#include "camera.h"

static const char *TAG = "http_stream";

#define BOUNDARY     "frame"
#define HDR_BUF_SIZE 96

static httpd_handle_t s_httpd = NULL;

static esp_err_t stream_handler(httpd_req_t *req) {
    if (!camera_acquire()) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "camera unavailable");
        return ESP_OK;
    }
    httpd_resp_set_type(req, "multipart/x-mixed-replace;boundary=" BOUNDARY);
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");

    char hdr[HDR_BUF_SIZE];
    int frames = 0;
    while (1) {
        camera_fb_t *fb = esp_camera_fb_get();
        if (!fb) { ESP_LOGW(TAG, "fb_get failed"); break; }

        int n = snprintf(hdr, HDR_BUF_SIZE,
            "\r\n--" BOUNDARY "\r\n"
            "Content-Type: image/jpeg\r\n"
            "Content-Length: %u\r\n\r\n", (unsigned)fb->len);

        esp_err_t err = httpd_resp_send_chunk(req, hdr, n);
        if (err == ESP_OK) {
            err = httpd_resp_send_chunk(req, (const char *)fb->buf, fb->len);
        }
        esp_camera_fb_return(fb);
        if (err != ESP_OK) { ESP_LOGI(TAG, "client gone after %d frame(s)", frames); break; }
        frames++;
    }
    httpd_resp_send_chunk(req, NULL, 0);
    camera_release();
    return ESP_OK;
}

void http_stream_init(void) {
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.server_port = 81;
    cfg.ctrl_port  = 32769;
    cfg.stack_size = 8192;
    if (httpd_start(&s_httpd, &cfg) != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed");
        return;
    }
    httpd_uri_t uri = {
        .uri      = "/stream",
        .method   = HTTP_GET,
        .handler  = stream_handler,
    };
    httpd_register_uri_handler(s_httpd, &uri);
    ESP_LOGI(TAG, "ready on :81/stream");
}
