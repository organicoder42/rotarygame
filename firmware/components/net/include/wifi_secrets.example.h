#pragma once
// Copy this file to `wifi_secrets.h` (gitignored — never commit the real one) and fill it in.
// Credentials saved later with net_wifi_join() live in NVS and override these at boot.

// The ESP32-S3 radio is 2.4 GHz only. If your router has separate names for 2.4 and 5 GHz, use
// the 2.4 GHz one; on a 5 GHz-only name the knob shows "wi-fi connecting..." forever.
#define KNOB_WIFI_SSID      "your-ssid"
#define KNOB_WIFI_PASS      "your-password"

// Where the upload exercise streams to: the reference receiver on your laptop
// (`python3 templates/receiver/receiver.py --port 8080`), reachable from the same Wi-Fi.
// Plain http is fine on a LAN; https works too (TLS validated against the mbedTLS cert bundle).
#define KNOB_RECEIVER_URL   "http://192.168.1.10:8080/upload/knob.bin"

// The knob also answers HTTP itself (net_serve.h): GET /status and POST /data. With a token set
// here, POST /data requires the header `X-Token: <token>`; "" leaves it open to everyone on the
// Wi-Fi. Set one whenever the network is not yours alone.
#define KNOB_SERVE_TOKEN    ""
