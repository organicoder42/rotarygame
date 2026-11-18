#include "blelink_frame.h"
#include <stdio.h>
#include <string.h>

bool blelink_name_format(char *buf, size_t cap, const uint8_t addr_le[6])
{
    if (cap == 0) return false;
    int n = snprintf(buf, cap, "Ekko-%02X%02X", (unsigned)addr_le[1], (unsigned)addr_le[0]);
    if (n < 0 || (size_t)n >= cap) {
        buf[0] = '\0';      // never a cut name: "Ekko-3A" would look like a real one
        return false;
    }
    return true;
}

size_t blelink_payload_max(uint16_t att_mtu)
{
    if (att_mtu < BLELINK_ATT_MTU_MIN) att_mtu = BLELINK_ATT_MTU_MIN;
    return (size_t)att_mtu - BLELINK_ATT_NOTIFY_HDR;
}

bool blelink_tx_idle(const blelink_tx_t *tx)
{
    return tx->off >= tx->len;
}

bool blelink_tx_load(blelink_tx_t *tx, const char *line, size_t len)
{
    if (!blelink_tx_idle(tx) || len == 0 || len > BLELINK_LINE_MAX) return false;
    memcpy(tx->buf, line, len);
    tx->len = len;
    tx->off = 0;
    return true;
}

size_t blelink_tx_peek(const blelink_tx_t *tx, uint16_t att_mtu, const char **chunk)
{
    if (blelink_tx_idle(tx)) return 0;
    size_t rest = tx->len - tx->off;
    size_t room = blelink_payload_max(att_mtu);
    *chunk = tx->buf + tx->off;
    return rest < room ? rest : room;
}

void blelink_tx_sent(blelink_tx_t *tx, size_t n)
{
    tx->off += n;
    if (blelink_tx_idle(tx)) blelink_tx_clear(tx);
}

void blelink_tx_clear(blelink_tx_t *tx)
{
    tx->len = 0;
    tx->off = 0;
}

bool blelink_tx_drop_unstarted(blelink_tx_t *tx)
{
    if (blelink_tx_idle(tx) || tx->off > 0) return false;
    blelink_tx_clear(tx);
    return true;
}

bool blelink_pool_has_room(int free_blocks, int small_blocks, int large_blocks)
{
    int small_free = free_blocks - large_blocks;
    return small_blocks > 0 && small_free >= (small_blocks + 1) / 2;
}
