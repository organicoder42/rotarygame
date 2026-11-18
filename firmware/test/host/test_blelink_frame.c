// Host tests for blelink_frame.c: the Bluetooth LE transport's decisions without a radio.
// The receive direction (GATT writes -> lines) is the shared assembler's job and is tested in
// test_hostlink_line.c.
#include "unity.h"
#include "blelink_frame.h"
#include <stdio.h>
#include <string.h>

void setUp(void) {}
void tearDown(void) {}

// ---- UUIDs: the bytes on the air against the text in PROTOCOL.md ----

static void assert_uuid(const char *text, const uint8_t le[16])
{
    static const int DASH_AFTER[] = { 4, 6, 8, 10 };    // bytes, counted from the text's left
    char got[37];
    size_t n = 0;
    for (int i = 0; i < 16; i++) {
        n += (size_t)snprintf(got + n, sizeof(got) - n, "%02x", (unsigned)le[15 - i]);
        for (int d = 0; d < 4; d++)
            if (i + 1 == DASH_AFTER[d]) got[n++] = '-';
    }
    got[n] = '\0';
    TEST_ASSERT_EQUAL_STRING(text, got);
}

void test_uuids_are_the_nordic_uart_service_of_the_contract(void)
{
    static const uint8_t service[16] = { BLELINK_UUID_SERVICE_LE };
    static const uint8_t rx[16]      = { BLELINK_UUID_RX_LE };
    static const uint8_t tx[16]      = { BLELINK_UUID_TX_LE };
    assert_uuid("6e400001-b5a3-f393-e0a9-e50e24dcca9e", service);
    assert_uuid("6e400002-b5a3-f393-e0a9-e50e24dcca9e", rx);
    assert_uuid("6e400003-b5a3-f393-e0a9-e50e24dcca9e", tx);
}

void test_requested_connection_parameters_are_the_contracts(void)
{
    TEST_ASSERT_EQUAL_INT(7500,  BLELINK_CONN_ITVL_MIN * 1250);   // microseconds
    TEST_ASSERT_EQUAL_INT(15000, BLELINK_CONN_ITVL_MAX * 1250);
    TEST_ASSERT_EQUAL_INT(0,     BLELINK_CONN_LATENCY);
    TEST_ASSERT_EQUAL_INT(2000,  BLELINK_CONN_TIMEOUT * 10);      // milliseconds
}

// ---- name ----

void test_name_is_the_last_two_address_bytes_as_written(void)
{
    // The address 24:58:7C:D3:3A:7F, least significant byte first as NimBLE hands it over.
    const uint8_t addr[6] = { 0x7F, 0x3A, 0xD3, 0x7C, 0x58, 0x24 };
    char name[BLELINK_NAME_MAX];
    TEST_ASSERT_TRUE(blelink_name_format(name, sizeof(name), addr));
    TEST_ASSERT_EQUAL_STRING("Ekko-3A7F", name);
}

void test_name_is_upper_case_and_zero_padded(void)
{
    const uint8_t addr[6] = { 0x0b, 0x00, 0xff, 0xff, 0xff, 0xff };
    char name[BLELINK_NAME_MAX];
    TEST_ASSERT_TRUE(blelink_name_format(name, sizeof(name), addr));
    TEST_ASSERT_EQUAL_STRING("Ekko-000B", name);
}

void test_name_that_does_not_fit_is_refused_not_cut(void)
{
    const uint8_t addr[6] = { 0x7F, 0x3A, 0, 0, 0, 0 };
    char name[BLELINK_NAME_MAX - 1] = "junk";
    TEST_ASSERT_FALSE(blelink_name_format(name, sizeof(name), addr));
    TEST_ASSERT_EQUAL_STRING("", name);
    TEST_ASSERT_FALSE(blelink_name_format(name, 0, addr));
}

// ---- how much of a line one notification carries ----

void test_payload_is_the_mtu_minus_the_notification_header(void)
{
    TEST_ASSERT_EQUAL_size_t(20,  blelink_payload_max(23));
    TEST_ASSERT_EQUAL_size_t(182, blelink_payload_max(185));
    TEST_ASSERT_EQUAL_size_t(253, blelink_payload_max(256));
}

void test_an_unknown_or_impossible_mtu_counts_as_the_default(void)
{
    TEST_ASSERT_EQUAL_size_t(20, blelink_payload_max(0));
    TEST_ASSERT_EQUAL_size_t(20, blelink_payload_max(22));
}

// ---- a line on its way out ----

// Send everything the state holds at `mtu`, the stack taking every piece; returns the number
// of notifications and appends what went out to `wire`.
static int drain(blelink_tx_t *tx, uint16_t mtu, char *wire, size_t cap)
{
    int pieces = 0;
    const char *chunk;
    size_t n;
    while ((n = blelink_tx_peek(tx, mtu, &chunk)) > 0) {
        TEST_ASSERT_TRUE(n <= blelink_payload_max(mtu));
        TEST_ASSERT_TRUE(strlen(wire) + n < cap);
        strncat(wire, chunk, n);
        blelink_tx_sent(tx, n);
        pieces++;
    }
    return pieces;
}

void test_a_line_that_fits_the_mtu_is_one_notification(void)
{
    static const char LINE[] = "!hello ekko 1\n";      // 14 bytes, fits even the default MTU
    blelink_tx_t tx = {0};
    char wire[BLELINK_LINE_MAX + 1] = "";
    TEST_ASSERT_TRUE(blelink_tx_load(&tx, LINE, sizeof(LINE) - 1));
    TEST_ASSERT_EQUAL_INT(1, drain(&tx, 23, wire, sizeof(wire)));
    TEST_ASSERT_EQUAL_STRING(LINE, wire);
    TEST_ASSERT_TRUE(blelink_tx_idle(&tx));
}

void test_a_state_line_at_the_default_mtu_is_split_in_order(void)
{
    static const char LINE[] = "!s -3 2 0 1 -6840 extra-x\n";      // 26 bytes: 20 + 6
    blelink_tx_t tx = {0};
    const char *chunk;
    TEST_ASSERT_TRUE(blelink_tx_load(&tx, LINE, sizeof(LINE) - 1));
    TEST_ASSERT_EQUAL_size_t(20, blelink_tx_peek(&tx, 23, &chunk));
    TEST_ASSERT_EQUAL_MEMORY(LINE, chunk, 20);
    blelink_tx_sent(&tx, 20);
    TEST_ASSERT_FALSE(blelink_tx_idle(&tx));
    TEST_ASSERT_EQUAL_size_t(6, blelink_tx_peek(&tx, 23, &chunk));
    TEST_ASSERT_EQUAL_MEMORY(LINE + 20, chunk, 6);
    blelink_tx_sent(&tx, 6);
    TEST_ASSERT_TRUE(blelink_tx_idle(&tx));
    TEST_ASSERT_EQUAL_size_t(0, blelink_tx_peek(&tx, 23, &chunk));
}

void test_the_same_line_at_a_negotiated_mtu_is_one_notification(void)
{
    static const char LINE[] = "!s -3 2 0 1 -6840 extra-x\n";
    blelink_tx_t tx = {0};
    char wire[BLELINK_LINE_MAX + 1] = "";
    TEST_ASSERT_TRUE(blelink_tx_load(&tx, LINE, sizeof(LINE) - 1));
    TEST_ASSERT_EQUAL_INT(1, drain(&tx, 185, wire, sizeof(wire)));
    TEST_ASSERT_EQUAL_STRING(LINE, wire);
}

void test_the_longest_line_goes_out_whole_at_the_default_mtu(void)
{
    char line[BLELINK_LINE_MAX];
    char wire[BLELINK_LINE_MAX + 1] = "";
    memset(line, '7', sizeof(line));
    line[sizeof(line) - 1] = '\n';
    blelink_tx_t tx = {0};
    TEST_ASSERT_TRUE(blelink_tx_load(&tx, line, sizeof(line)));
    TEST_ASSERT_EQUAL_INT(4, drain(&tx, 23, wire, sizeof(wire)));     // 20 + 20 + 20 + 4
    TEST_ASSERT_EQUAL_size_t(sizeof(line), strlen(wire));
    TEST_ASSERT_EQUAL_MEMORY(line, wire, sizeof(line));
}

void test_a_line_over_the_limit_or_empty_is_refused(void)
{
    char line[BLELINK_LINE_MAX + 1];
    memset(line, 'x', sizeof(line));
    blelink_tx_t tx = {0};
    TEST_ASSERT_FALSE(blelink_tx_load(&tx, line, sizeof(line)));
    TEST_ASSERT_FALSE(blelink_tx_load(&tx, line, 0));
    TEST_ASSERT_TRUE(blelink_tx_idle(&tx));
}

// The stack took the first piece and refused the second: the next line must wait, and what
// reaches the central is still two whole lines.
void test_a_started_line_is_finished_before_the_next_is_accepted(void)
{
    static const char FIRST[]  = "!s 1 0 0 0 -7400 padding\n";      // 25 bytes
    static const char SECOND[] = "!s 2 0 0 0 -7300\n";
    blelink_tx_t tx = {0};
    char wire[2 * BLELINK_LINE_MAX + 1] = "";
    const char *chunk;

    TEST_ASSERT_TRUE(blelink_tx_load(&tx, FIRST, sizeof(FIRST) - 1));
    size_t n = blelink_tx_peek(&tx, 23, &chunk);
    strncat(wire, chunk, n);
    blelink_tx_sent(&tx, n);                                        // 20 bytes out, 5 refused

    TEST_ASSERT_FALSE(blelink_tx_load(&tx, SECOND, sizeof(SECOND) - 1));   // dropped by the caller
    TEST_ASSERT_EQUAL_INT(1, drain(&tx, 23, wire, sizeof(wire)));          // the rest of FIRST
    TEST_ASSERT_TRUE(blelink_tx_load(&tx, SECOND, sizeof(SECOND) - 1));
    TEST_ASSERT_EQUAL_INT(1, drain(&tx, 23, wire, sizeof(wire)));
    TEST_ASSERT_EQUAL_STRING("!s 1 0 0 0 -7400 padding\n!s 2 0 0 0 -7300\n", wire);
}

void test_a_piece_the_stack_refused_is_offered_again_unchanged(void)
{
    static const char LINE[] = "!s 5 0 0 0 -7400\n";
    blelink_tx_t tx = {0};
    const char *first, *again;
    TEST_ASSERT_TRUE(blelink_tx_load(&tx, LINE, sizeof(LINE) - 1));
    size_t n1 = blelink_tx_peek(&tx, 23, &first);
    size_t n2 = blelink_tx_peek(&tx, 23, &again);                   // nothing was sent in between
    TEST_ASSERT_EQUAL_size_t(n1, n2);
    TEST_ASSERT_EQUAL_PTR(first, again);
}

void test_clear_forgets_a_half_sent_line(void)
{
    static const char LINE[] = "!s 1 0 0 0 -7400 padding\n";
    blelink_tx_t tx = {0};
    const char *chunk;
    TEST_ASSERT_TRUE(blelink_tx_load(&tx, LINE, sizeof(LINE) - 1));
    blelink_tx_sent(&tx, blelink_tx_peek(&tx, 23, &chunk));
    blelink_tx_clear(&tx);                                          // the central disconnected
    TEST_ASSERT_TRUE(blelink_tx_idle(&tx));
    TEST_ASSERT_EQUAL_size_t(0, blelink_tx_peek(&tx, 23, &chunk));
    TEST_ASSERT_TRUE(blelink_tx_load(&tx, "!s 2 0 0 0 -7300\n", 17));
    TEST_ASSERT_EQUAL_size_t(17, blelink_tx_peek(&tx, 23, &chunk)); // starts at its own first byte
    TEST_ASSERT_EQUAL_MEMORY("!s 2", chunk, 4);
}

// The stack refused the first piece: by the contract that line is dropped, not kept for later.
void test_a_line_the_stack_took_nothing_of_is_dropped(void)
{
    static const char STALE[] = "!s 1 0 0 0 -7400\n";
    static const char FRESH[] = "!s 2 0 0 0 -7300\n";
    blelink_tx_t tx = {0};
    const char *chunk;
    TEST_ASSERT_TRUE(blelink_tx_load(&tx, STALE, sizeof(STALE) - 1));
    TEST_ASSERT_TRUE(blelink_tx_drop_unstarted(&tx));               // nothing of it went out
    TEST_ASSERT_TRUE(blelink_tx_idle(&tx));
    TEST_ASSERT_TRUE(blelink_tx_load(&tx, FRESH, sizeof(FRESH) - 1));
    TEST_ASSERT_EQUAL_size_t(sizeof(FRESH) - 1, blelink_tx_peek(&tx, 23, &chunk));
    TEST_ASSERT_EQUAL_MEMORY(FRESH, chunk, sizeof(FRESH) - 1);
}

void test_a_started_line_is_never_dropped_and_idle_has_nothing_to_drop(void)
{
    static const char LINE[] = "!s 1 0 0 0 -7400 padding\n";
    blelink_tx_t tx = {0};
    const char *chunk;
    TEST_ASSERT_FALSE(blelink_tx_drop_unstarted(&tx));              // idle
    TEST_ASSERT_TRUE(blelink_tx_load(&tx, LINE, sizeof(LINE) - 1));
    blelink_tx_sent(&tx, blelink_tx_peek(&tx, 23, &chunk));         // 20 of 25 bytes are out
    TEST_ASSERT_FALSE(blelink_tx_drop_unstarted(&tx));
    TEST_ASSERT_EQUAL_size_t(5, blelink_tx_peek(&tx, 23, &chunk));  // the rest is still owed
}

// ---- buffer-pool gate: 12 small blocks carry the notifications, 24 large ones do not ----

void test_pool_gate_looks_at_the_small_pool_only(void)
{
    TEST_ASSERT_TRUE(blelink_pool_has_room(36, 12, 24));    // everything free
    TEST_ASSERT_TRUE(blelink_pool_has_room(30, 12, 24));    // 6 of 12 small blocks free
    TEST_ASSERT_FALSE(blelink_pool_has_room(29, 12, 24));   // 5 of 12
    // The case the first version got wrong: the small pool is empty, yet two thirds of all
    // blocks are free because nothing ever uses the large pool.
    TEST_ASSERT_FALSE(blelink_pool_has_room(24, 12, 24));
}

void test_pool_gate_rounds_half_up_and_errs_on_the_closed_side(void)
{
    TEST_ASSERT_TRUE(blelink_pool_has_room(3 + 8, 5, 8));   // odd pool: 3 of 5
    TEST_ASSERT_FALSE(blelink_pool_has_room(2 + 8, 5, 8));
    // A large block in use makes the estimate one too low: closed a little early, never late.
    TEST_ASSERT_FALSE(blelink_pool_has_room(29, 12, 24));
}

void test_pool_gate_is_shut_without_a_small_pool(void)
{
    TEST_ASSERT_FALSE(blelink_pool_has_room(24, 0, 24));
    TEST_ASSERT_FALSE(blelink_pool_has_room(0, 0, 0));
    TEST_ASSERT_FALSE(blelink_pool_has_room(10, -1, 0));
}

int main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_uuids_are_the_nordic_uart_service_of_the_contract);
    RUN_TEST(test_requested_connection_parameters_are_the_contracts);
    RUN_TEST(test_name_is_the_last_two_address_bytes_as_written);
    RUN_TEST(test_name_is_upper_case_and_zero_padded);
    RUN_TEST(test_name_that_does_not_fit_is_refused_not_cut);
    RUN_TEST(test_payload_is_the_mtu_minus_the_notification_header);
    RUN_TEST(test_an_unknown_or_impossible_mtu_counts_as_the_default);
    RUN_TEST(test_a_line_that_fits_the_mtu_is_one_notification);
    RUN_TEST(test_a_state_line_at_the_default_mtu_is_split_in_order);
    RUN_TEST(test_the_same_line_at_a_negotiated_mtu_is_one_notification);
    RUN_TEST(test_the_longest_line_goes_out_whole_at_the_default_mtu);
    RUN_TEST(test_a_line_over_the_limit_or_empty_is_refused);
    RUN_TEST(test_a_started_line_is_finished_before_the_next_is_accepted);
    RUN_TEST(test_a_piece_the_stack_refused_is_offered_again_unchanged);
    RUN_TEST(test_clear_forgets_a_half_sent_line);
    RUN_TEST(test_a_line_the_stack_took_nothing_of_is_dropped);
    RUN_TEST(test_a_started_line_is_never_dropped_and_idle_has_nothing_to_drop);
    RUN_TEST(test_pool_gate_looks_at_the_small_pool_only);
    RUN_TEST(test_pool_gate_rounds_half_up_and_errs_on_the_closed_side);
    RUN_TEST(test_pool_gate_is_shut_without_a_small_pool);
    return UNITY_END();
}
