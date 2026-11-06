// Prompts that do not echo (AC27). Secret values come only from the environment or from this prompt; with no
// terminal attached there is nothing to ask, so the prompt answers null instead of waiting on a pipe.

export function createPrompt({ stdin = process.stdin, stderr = process.stderr } = {}) {
  /** @param {{ name: string, message: string, echo?: boolean }} question */
  return function prompt({ message }) {
    if (!stdin.isTTY || !stderr.isTTY || typeof stdin.setRawMode !== "function") return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      stderr.write(`${message}: `);
      let value = "";
      stdin.setEncoding("utf8");
      stdin.setRawMode(true);
      stdin.resume();
      const finish = (callback) => {
        stdin.off("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
        stderr.write("\n");
        callback();
      };
      const onData = (chunk) => {
        for (const character of chunk) {
          if (character === "\r" || character === "\n") return finish(() => resolve(value));
          if (character === "\u0003") return finish(() => reject(new Error("interrupted at the prompt")));
          if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
          else value += character;
        }
      };
      stdin.on("data", onData);
    });
  };
}
