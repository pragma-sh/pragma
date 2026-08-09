export { MenuView, type MenuAction } from "@react-native-menu/menu";

// Native: the platform pull-down menu, unchanged. The web build swaps in
// `menu-view.web.tsx`, which reproduces the same props over a popover. Screens
// import from here rather than from `@react-native-menu/menu` so neither
// platform reaches into the other's implementation.
