// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Deepshaft — the count-in on the cage. Each peer counts locally from the moment the run starts, so
// everyone is in step to within one network hop and the mine is not a jump-cut.
//
// Driven by setInterval, never rAF: a backgrounded tab never fires rAF, and a count-in that silently
// never finishes is a hang rather than a delay.

import type { Sfx } from '@ben-gy/game-engine/sound';

export interface Countdown {
  cancel(): void;
}

export function runCountdown(
  container: HTMLElement,
  sfx: Sfx,
  onDone: () => void,
  steps: string[] = ['3', '2', '1', 'DOWN'],
): Countdown {
  const el = document.createElement('div');
  el.className = 'countdown';
  el.setAttribute('aria-live', 'assertive');
  container.appendChild(el);

  let i = 0;
  let done = false;
  let timer = 0 as unknown as ReturnType<typeof setInterval>;

  const finish = (): void => {
    if (done) return;
    done = true;
    clearInterval(timer);
    el.remove();
    onDone();
  };

  const show = (): void => {
    if (i >= steps.length) {
      finish();
      return;
    }
    el.textContent = steps[i];
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
    try {
      sfx.play(i === steps.length - 1 ? 'go' : 'beat');
    } catch {
      /* audio must never break a run starting */
    }
    i++;
  };

  show();
  timer = setInterval(show, 540);

  return {
    cancel() {
      if (done) return;
      done = true;
      clearInterval(timer);
      el.remove();
    },
  };
}
