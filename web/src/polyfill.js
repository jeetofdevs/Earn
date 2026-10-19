// NEAR wallet libraries expect Node's Buffer and global in the browser.
import { Buffer } from "buffer";
globalThis.Buffer = globalThis.Buffer || Buffer;
globalThis.global = globalThis.global || globalThis;
