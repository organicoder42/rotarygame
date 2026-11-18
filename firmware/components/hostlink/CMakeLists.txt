# The USB Serial/JTAG port as a line transport: one reader task, whole-line writes.
# hostlink_line.c is pure and host-tested (test/host/test_hostlink_line.c); blelink reuses it.
idf_component_register(
    SRCS "hostlink.c" "hostlink_line.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_driver_usb_serial_jtag
)
