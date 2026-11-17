#include "hud_view.h"

hud_view_t hud_view_for(bool connected, uint8_t phase)
{
    static const hud_view_t BY_PHASE[] = {
        HUD_VIEW_READY, HUD_VIEW_PLAYING, HUD_VIEW_PAUSED, HUD_VIEW_OVER,
    };
    if (!connected) return HUD_VIEW_OFFLINE;
    return phase < sizeof(BY_PHASE) / sizeof(BY_PHASE[0]) ? BY_PHASE[phase] : HUD_VIEW_READY;
}

theme_state_t hud_view_health_state(uint8_t health)
{
    if (health >= HUD_HEALTH_HIGH_MIN)   return THEME_STATE_IDLE;
    if (health >= HUD_HEALTH_MEDIUM_MIN) return THEME_STATE_LOW_BATTERY;   // the caution amber
    return THEME_STATE_ERROR;
}

theme_state_t hud_view_motion_state(hud_view_t view)
{
    static const theme_state_t MOTION[HUD_VIEW_COUNT] = {
        [HUD_VIEW_OFFLINE] = THEME_STATE_IDLE,        // slow breathing: waiting
        [HUD_VIEW_READY]   = THEME_STATE_IDLE,
        [HUD_VIEW_PLAYING] = THEME_STATE_RECORDING,   // solid: live
        [HUD_VIEW_PAUSED]  = THEME_STATE_PAUSED,
        [HUD_VIEW_OVER]    = THEME_STATE_RECORDING,   // solid: nothing is happening any more
    };
    return (unsigned)view < HUD_VIEW_COUNT ? MOTION[view] : THEME_STATE_RECORDING;
}

const char *hud_view_tag(hud_view_t view)
{
    static const char *const TAG[HUD_VIEW_COUNT] = {
        [HUD_VIEW_OFFLINE] = "",
        [HUD_VIEW_READY]   = "klar",
        [HUD_VIEW_PLAYING] = "spiller",
        [HUD_VIEW_PAUSED]  = "pause",
        [HUD_VIEW_OVER]    = "slut",
    };
    return (unsigned)view < HUD_VIEW_COUNT ? TAG[view] : "";
}

bool hud_view_link_alive(bool seen, uint32_t last_ms, uint32_t now_ms)
{
    return seen && (uint32_t)(now_ms - last_ms) < HUD_LINK_TIMEOUT_MS;
}

int hud_view_mic_pct(int level_cdb)
{
    if (level_cdb <= HUD_MIC_QUIET_CDB) return 0;
    if (level_cdb >= HUD_MIC_LOUD_CDB)  return 100;
    return (level_cdb - HUD_MIC_QUIET_CDB) * 100 / (HUD_MIC_LOUD_CDB - HUD_MIC_QUIET_CDB);
}

int hud_view_meter_step(int shown_pct, int target_pct)
{
    if (target_pct >= shown_pct) return target_pct;
    int fallen = shown_pct - HUD_METER_DECAY_PCT;
    return fallen > target_pct ? fallen : target_pct;
}
