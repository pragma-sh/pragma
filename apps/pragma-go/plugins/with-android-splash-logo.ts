import { AndroidConfig, type ConfigPlugin, withAndroidStyles } from "expo/config-plugins";

/** The style group `expo-splash-screen` writes into `res/values/styles.xml`. */
const SPLASH_STYLE = { name: "Theme.App.SplashScreen", parent: "Theme.SplashScreen" };

/** The item pointing at the (optional) splash logo drawable. */
const ANIMATED_ICON_ITEM = "windowSplashScreenAnimatedIcon";

/**
 * Drops the dangling `@drawable/splashscreen_logo` reference from the Android
 * splash theme.
 *
 * `expo-splash-screen` writes that item unconditionally
 * (`withAndroidSplashStyles`), but only writes the drawable itself when the
 * plugin is configured with an `image`/`drawable` (`withAndroidSplashImages`).
 * Pragma Go's splash is a background colour with no logo — matching the iOS
 * storyboard, which has no image view — so the drawable never exists and
 * `:app:processDebugResources` fails with
 * `resource drawable/splashscreen_logo ... not found`.
 *
 * Removing the item lets Android fall back to the launcher icon, which is what
 * `android:windowSplashScreenBehavior="icon_preferred"` already asks for.
 *
 * Must be listed **before** `expo-splash-screen` in the plugins array. Mods run
 * last-registered-first (each `withMod` intercepts the one already on the
 * config and calls it as `nextMod`), so an earlier entry runs *after* a later
 * one — listing this plugin after `expo-splash-screen` lets that plugin re-add
 * the item and the build fails again.
 */
export const withAndroidSplashLogo: ConfigPlugin = (config) =>
  withAndroidStyles(config, (styles) => {
    const group = AndroidConfig.Resources.findResourceGroup(
      styles.modResults.resources.style,
      SPLASH_STYLE,
    );
    if (group) {
      group.item = group.item.filter((item) => item.$.name !== ANIMATED_ICON_ITEM);
    }
    return styles;
  });

export default withAndroidSplashLogo;
