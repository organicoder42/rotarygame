# Bluetooth LE as a line transport (PROTOCOL.md, "Bluetooth LE (wireless)"): a NimBLE peripheral
# with the Nordic UART Service. blelink_frame.c is pure and host-tested
# (test/host/test_blelink_frame.c). hostlink is required only for its pure line assembler.
idf_component_register(
    SRCS "blelink.c" "blelink_gap.c" "blelink_frame.c"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES bt hostlink
)
