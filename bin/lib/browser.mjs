// The default browser opener. Only http(s) URLs are ever opened; failure to open is not fatal (the URL is printed).

import { spawn } from "node:child_process";

export function openInBrowser(url) {
  if (!/^https?:\/\//.test(url)) return Promise.reject(new Error("only http and https URLs are opened"));
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
