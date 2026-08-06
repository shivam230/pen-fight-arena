/**
 * native.js — the thin layer between the game and the native shell.
 *
 * Everything here degrades to a no-op in a browser, so the web build and the
 * store build run the exact same code. The plugins' own web implementations are
 * used where they exist (Haptics falls back to navigator.vibrate on Android
 * Chrome, and silently does nothing on desktop).
 *
 * Haptics are not decoration. A pen striking a pen is the single most important
 * event in the game, and on a phone the taptic hit is most of what sells it —
 * it is also the kind of platform integration App Review looks for when deciding
 * whether something is a real app or a wrapped website.
 */

import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { StatusBar, Style } from '@capacitor/status-bar';
import { SplashScreen } from '@capacitor/splash-screen';

export const isNative = () => Capacitor.isNativePlatform();

let hapticsOn = true;
let lastHaptic = 0;

/** Mirrors the sound toggle — one control for "stop buzzing at me". */
export function setHapticsEnabled(on) {
  hapticsOn = on;
}

/**
 * Pen-on-pen contact. `strength` is the solver's 0..1 normal impulse, so the
 * taptic weight tracks how hard the hit actually was.
 */
export function hapticImpact(strength) {
  if (!hapticsOn || !isNative()) return;
  const now = performance.now();
  // A collision cluster fires several contacts in a few milliseconds; without a
  // gate the phone buzzes continuously instead of thumping once.
  if (now - lastHaptic < 90) return;
  lastHaptic = now;
  const style = strength > 0.62 ? ImpactStyle.Heavy
    : strength > 0.28 ? ImpactStyle.Medium
      : ImpactStyle.Light;
  Haptics.impact({ style }).catch(() => {});
}

/** A pen going over the edge — the moment that decides a round. */
export function hapticKnockout(mine) {
  if (!hapticsOn || !isNative()) return;
  lastHaptic = performance.now();
  Haptics.notification({
    type: mine ? NotificationType.Error : NotificationType.Success,
  }).catch(() => {});
}

/** Light tick for menu selection. */
export function hapticSelect() {
  if (!hapticsOn || !isNative()) return;
  Haptics.selectionChanged().catch(() => {});
}

/**
 * Called once the first frame is on screen. Hiding the splash manually (rather
 * than on a timer) means the player never sees a blank frame between the launch
 * image and the game drawing itself.
 */
export async function initNative() {
  if (!isNative()) return;
  try {
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setOverlaysWebView({ overlay: true });
  } catch { /* not available on this platform */ }
  try {
    await SplashScreen.hide({ fadeOutDuration: 220 });
  } catch { /* already hidden */ }
}
