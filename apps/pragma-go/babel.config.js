/** Babel config for the Pragma Mobile Expo app. */
module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { jsxImportSource: "nativewind" }], "nativewind/babel"],
    // react-native-worklets/reanimated plugin must be listed last.
    plugins: ["react-native-worklets/plugin"],
  };
};
