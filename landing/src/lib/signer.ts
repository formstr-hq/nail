import { createSigner } from "@formstr/signer";

// One signer instance for the whole page. appName is what remote signers
// (NIP-46 nostrconnect) display on their approval prompt.
export const signer = createSigner({
  appName: "Mailstr",
  appUrl: "https://mailstr.app",
});
