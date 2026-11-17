#pragma once
// testctl — development-only serial console for automated verification loops (see the
// verify-on-device skill). It does NOT own the port: components/hostlink reads it, the app
// takes the protocol lines (`hello`, `hud`, `hap`) and hands every other line to this console.
// One command per line, replies start with "> " (the browser ignores every line without '!'):
//   knob <+N|-N>   inject N detents (sign = direction)        -> "> link=.. k=.. t=.. ..."
//   tap            inject one short tap on the screen         -> the same state line
//   zone           inject one short tap on the small circle   -> the same state line
//   hold           inject one long press                      -> the same state line
//   reset          counters 0, last hud forgotten             -> the same state line
//   state          report the model (app_state_line)          -> the same state line
//   snap           dump the framebuffer: "SNAP BEGIN w h RGB565", 1 row per "S:<base64>" line,
//                  "SNAP END". `!s` lines keep flowing between the rows; no row is ever split.
//   ping           -> "> pong"
// Depends on app (the app_inject_* hooks), ui (the LVGL lock) and hostlink (whole-line writes).
// Threading: commands run on the host-link reader task. Compiled in only with
// CONFIG_KNOB_TESTCTL; without it unknown lines are silently ignored, as the contract says.

// Register the console with the app. Call after app_init().
void testctl_init(void);
