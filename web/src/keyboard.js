// Keyboard stand-in for the knobs, so the game is fully playable without them.
//
//                 player 1        player 2
//   one detent    Left / Right    A / D        (auto-repeats while held)
//   tap           Space           W
//   circle tap    X               S
//   noise         M (held)        Q (held)
//   clap          N               E
//   long press    Enter           (either player's long press works)
//
//   I  debug overlay,  F  full screen
//
// Pressing any player-2 key makes player 2 join.

const PLAYER_KEYS = [
  { left: 'ArrowLeft', right: 'ArrowRight', tap: 'Space', flip: 'KeyX', blow: 'KeyM', clap: 'KeyN' },
  { left: 'KeyA', right: 'KeyD', tap: 'KeyW', flip: 'KeyS', blow: 'KeyQ', clap: 'KeyE' },
];

/**
 * @param {object} handlers
 * @param {(event: object) => void} handlers.onEvent   receives game input events (with `player`)
 * @param {(player: number) => void} handlers.onClap
 * @param {(player: number) => void} handlers.onPlayerKey  a key of that player was pressed
 * @param {() => void} handlers.onToggleDebug
 * @param {() => void} handlers.onToggleFullscreen
 * @returns {{ blowing: boolean[] }} live view of the noise keys, per player
 */
export function attachKeyboard({ onEvent, onClap, onPlayerKey, onToggleDebug, onToggleFullscreen }) {
  const keys = { blowing: [false, false] };

  function playerKey(e) {
    for (let player = 0; player < PLAYER_KEYS.length; player++) {
      const map = PLAYER_KEYS[player];
      const action = Object.keys(map).find((name) => map[name] === e.code);
      if (!action) continue;
      onPlayerKey(player);
      if (action === 'left') onEvent({ type: 'turn', player, detents: -1 });
      else if (action === 'right') onEvent({ type: 'turn', player, detents: 1 });
      else if (action === 'blow') keys.blowing[player] = true;
      else if (e.repeat) return true;
      else if (action === 'tap') onEvent({ type: 'tap', player });
      else if (action === 'flip') onEvent({ type: 'flip', player });
      else if (action === 'clap') onClap(player);
      return true;
    }
    return false;
  }

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!playerKey(e)) {
      switch (e.code) {
        case 'Enter':
        case 'NumpadEnter':
          if (!e.repeat) onEvent({ type: 'hold', player: 0 });
          break;
        case 'KeyI':
          if (!e.repeat) onToggleDebug();
          break;
        case 'KeyF':
          if (!e.repeat) onToggleFullscreen();
          break;
        default:
          return;
      }
    }
    // Keeps Space/Enter from re-clicking a focused button and arrows from scrolling.
    e.preventDefault();
  });

  window.addEventListener('keyup', (e) => {
    PLAYER_KEYS.forEach((map, player) => {
      if (e.code === map.blow) keys.blowing[player] = false;
    });
  });
  window.addEventListener('blur', () => {
    keys.blowing.fill(false);
  });

  return keys;
}
