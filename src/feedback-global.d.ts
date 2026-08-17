// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// The feedback widget is HOSTED (feedback.benrichardson.dev/w.js, loaded from index.html) and
// self-mounts into `.site-footer`. This ambient type is the whole integration on the TS side —
// there is no src/feedback.ts to vendor.

declare global {
  interface Window {
    feedback?: {
      open(o?: { returnFocusTo?: HTMLElement | null; build?: string; label?: string }): void;
      mount(o?: object): void;
    };
  }
}

export {};
