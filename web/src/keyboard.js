// Keyboard stand-in for the knob, so the game is fully playable without it.
//
//   Left / Right  one detent each (auto-repeats while held)
//   Space         tap on the screen
//   X             tap on the small circle
//   Enter         long press
//   M (held)      noise into the microphone
//   N             a clap
//   D             debug overlay,  F  full screen

/**
 * @param {object} handlers
 * @param {(event: object) => void} handlers.onEvent   receives game input events
 * @param {() => void} handlers.onClap
 * @param {() => void} handlers.onToggleDebug
 * @param {() => void} handlers.onToggleFullscreen
 * @returns {{ blowing: boolean }} live view of the M key
 */
export function attachKeyboard({ onEvent, onClap, onToggleDebug, onToggleFullscreen }) {
  const keys = { blowing: false };

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.code) {
      case 'ArrowLeft':
        onEvent({ type: 'turn', detents: -1 });
        break;
      case 'ArrowRight':
        onEvent({ type: 'turn', detents: 1 });
        break;
      case 'Space':
        if (!e.repeat) onEvent({ type: 'tap' });
        break;
      case 'KeyX':
        if (!e.repeat) onEvent({ type: 'flip' });
        break;
      case 'Enter':
      case 'NumpadEnter':
        if (!e.repeat) onEvent({ type: 'hold' });
        break;
      case 'KeyM':
        keys.blowing = true;
        break;
      case 'KeyN':
        if (!e.repeat) onClap();
        break;
      case 'KeyD':
        if (!e.repeat) onToggleDebug();
        break;
      case 'KeyF':
        if (!e.repeat) onToggleFullscreen();
        break;
      default:
        return;
    }
    // Keeps Space/Enter from re-clicking a focused button and arrows from scrolling.
    e.preventDefault();
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'KeyM') keys.blowing = false;
  });
  window.addEventListener('blur', () => {
    keys.blowing = false;
  });

  return keys;
}
