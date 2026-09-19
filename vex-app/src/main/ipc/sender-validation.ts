/**
 * Sender/frame validation for the IPC handler harness.
 *
 * Every handler validates `event.senderFrame.url` against the trusted
 * origins before doing any work: only the top frame of the packaged
 * `app://vex` origin (or, when not packaged, the dev server) may invoke
 * an IPC channel. Subframes and untrusted origins are rejected with a
 * thrown `Untrusted IPC sender` error that `registerHandler` normalises
 * into a redacted `validation.invalid_sender` Result.
 */

import { app } from "electron";
import { type IpcMainInvokeEvent } from "electron";

const TRUSTED_PRODUCTION_ORIGIN = "app://vex";
const TRUSTED_DEV_ORIGIN = `http://127.0.0.1:${process.env.VEX_RENDERER_PORT ?? "5173"}`;

export function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  if (!frame) {
    throw new Error("Untrusted IPC sender: <missing frame>");
  }
  if (frame.parent !== null || frame.top !== frame) {
    throw new Error("Untrusted IPC sender: subframe");
  }

  const url = frame.url;
  const trusted =
    url.startsWith(`${TRUSTED_PRODUCTION_ORIGIN}/`) ||
    url === TRUSTED_PRODUCTION_ORIGIN ||
    (!app.isPackaged &&
      (url.startsWith(`${TRUSTED_DEV_ORIGIN}/`) || url === TRUSTED_DEV_ORIGIN));

  if (!trusted) {
    throw new Error(`Untrusted IPC sender: ${url || "<unknown>"}`);
  }
}
