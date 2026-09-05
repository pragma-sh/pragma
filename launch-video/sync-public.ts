import { copyFile } from "node:fs/promises";

const exportFile = new URL("../.github/assets/pragma-launch.mp4", import.meta.url);
const publicFile = new URL("../apps/www/public/media/pragma-launch.mp4", import.meta.url);

await copyFile(exportFile, publicFile);
