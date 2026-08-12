import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Native shell config.
 *
 * The web build is bundled INTO the app — `server.url` is deliberately not set.
 * Pointing a shell at a hosted URL is both an App Review guideline 4.2 rejection
 * risk ("a repackaged website") and a guarantee that the game breaks on a plane.
 * Everything it needs is already local: the whole thing ships zero downloaded
 * assets, so offline is free.
 */
const config: CapacitorConfig = {
  appId: 'com.studio4by5.penfight',
  appName: 'Pen Fight',
  webDir: 'dist',

  // The game is a full-bleed canvas; nothing about it should scroll or rubber-band.
  ios: {
    contentInset: 'never',
    scrollEnabled: false,
    backgroundColor: '#05070a',
    // Let the WKWebView composite the WebGL canvas as efficiently as it can.
    limitsNavigationsToAppBoundDomains: true,
  },
  android: {
    backgroundColor: '#05070a',
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },

  plugins: {
    SplashScreen: {
      launchShowDuration: 0,      // the game draws its own boot bar immediately
      backgroundColor: '#05070a',
      showSpinner: false,
      androidSplashResourceName: 'splash',
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: 'DARK',              // dark UI => light content
      backgroundColor: '#05070a',
      overlaysWebView: true,      // we handle safe areas in CSS already
    },
  },
};

export default config;
