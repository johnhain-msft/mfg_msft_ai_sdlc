import { createHash } from "node:crypto";

// SHA-256 digests of lower-case phrases that must never be published (synthetic phrases in this fixture).
const DIGESTS = new Set([
  "123740dd001f553c080ce76b7045deab5697af0f830306c9042e65debdbbc2b6",
  "54345fde5911c30f2d224db31d78a488c5cbb2b44e92d06fc29183a4dc626cee",
  "25f9474058d7d9a928c3a927475b4429ea81be34e832001d3984d5c9f4f78215",
  "2f9506c68bbf2095936fd1b258e07123b5b8a9c73652e943c32255db51abe5c9",
  "177ef11aa24689719f279af5d4195c8bffcdb6531729aa86b6e97839399622f8",
  "a42843e4ab7900df932bd48c87d5b2143501c04c343a1e07e692e0229271b179",
  "191721316cd2c7f2fcb2073da03ea05fb81d4736e609e9bc223a4540109e234c",
  "93eb23bf4fbf8d02f613c8b2816de79d88610e6d04796ec6d3f8f593ab6df8ce",
  "9b41a6e267cbe1bba9dc9dccfdc1f72e4a1437bcabd9db810ed42ab6246b7f29",
  "e515c8481cc6e6b86220b09c6798c5c7c7d66ccf0467202dcf5fda8382d899e4",
  "bafaf3dc2e1849dfd04e1b3b83199f2af98098b2d2a5af42ab60345df48ecd7a",
  "3028f2d9d4b284902f102d5591fdea1591a7c89bc661d50bf11b929615f425a4",
  "2f5be2de21664b231e25540f62fe6ab9649c11f0ac19c16b0dfd5844fc74487b",
  "0a31aece00105a0eb12e1ae6fd96c09411e62af8aee3f298f74ecb0714b4090d",
  "ede763b199c7daa1248b7fd4da0f53aaf2a4b26c918cd0712263975fa2c8dbaf",
  "d5cb7feb3ab01a3ff9a182a2eafb9cb945cf1379f0c5aa49687349e61707ad24",
  "0db1fc38ec04b865a575a7522b6434db017ef1654b6dcfec07c884bc12664a65",
  "f409fb1f112266a5ff37b26369c7d6b17c4df3b6d7f3134b6e27307c5f99f73d",
  "ebd47c94dd46d4b06ad2a5084e542669b3bd8ca0c573db347959cbc23c64528b",
  "a803963ad79356bf0c3d3db7563f283b2e56c2092af80933bdff4ce16af061e0",
  "ef993a6ada6d7081aa5aa83a7459977749b35936f81b3f594abceb318e45a37e",
  "b81e527e0081a27dcb084ca918a9bff1fbddd08cf98adecf9881d3ee70efd0b3",
  "2e3802e3655fc4a00056aefe43aaf8c3dc1c2889ae1e3411878901b33e11fa5d",
  "b34717094b6e689cebf24561c38230f8dcace234339d15d44bea7d589a8c1f27",
  "cc750db5c04d60f713f10f595615611f2f8c5af100b81da0f0fdfe1489b88957",
  "ce61a7df877f29c3d54c5e8585cba8d253375feab6b2c8c2b20d67dcf7a2a6d1",
]);

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Returns every one-, two- and three-word phrase in the text whose digest is on the list. */
export function findCustomerTerms(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const hits = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 3 && i + n <= words.length; n++) {
      const phrase = words.slice(i, i + n).join(" ");
      if (DIGESTS.has(digest(phrase))) hits.add(phrase);
    }
  }
  return [...hits];
}
