// One listening turn over the realtime transcription socket: open the
// socket, start the microphone, stream audio until the API reports the end
// of the user's turn, return its transcript. The API does the turn
// detection; this file only moves bytes and keeps the books. Nothing is
// written to disk. Needs Node 22 or newer for the built-in WebSocket.
import type { Readable } from "node:stream";

import { STT_REALTIME_MODEL } from "./api.js";
import { startRecording, noRecorderMessage, SAMPLE_RATE, type Recording } from "./recorder.js";

export interface ListenOptions {
  baseUrl: string;
  apiKey: string;
  language?: string;
  style?: "verbatim" | "clean";
  convention?: "spoken" | "written";
  vocabulary?: string[];
  /** Stop and return whatever was heard after this many seconds of audio. */
  maxSeconds: number;
  /** Give up when no speech has started after this many seconds. */
  waitSeconds: number;
  /** PAXA_MIC: the device the recorder should use. */
  device: string | undefined;
  /** Whether this machine is currently playing speech, so the API can tell our voice from the user's. */
  isSpeaking: () => boolean;
  /** Test seam: raw s16le mono 16 kHz PCM to send instead of the microphone. Not reachable from the tool. */
  source?: Readable;
}

export interface ListenResult {
  text: string;
  turn: number | null;
  /** Seconds of speech, from speech_started to speech_ended, when a turn was heard. */
  speechSeconds: number | null;
  /** Seconds of audio sent over the connection. */
  audioSeconds: number;
  credits: number;
  endedBy: "turn" | "max_seconds" | "no_speech";
  connection: string | null;
  recorder: string;
}

const FRAME_BYTES = 32 * 1024;

interface ServerEvent {
  type: string;
  turn?: number;
  is_final?: boolean;
  text?: string;
  start?: number;
  end?: number;
  time?: number;
  connection?: string;
  seconds?: number;
  credits?: number;
  total_credits?: number;
  total_seconds?: number;
  code?: string;
  not_billed?: number;
}

export function realtimeSupported(): boolean {
  return typeof WebSocket === "function";
}

export async function listenOnce(options: ListenOptions): Promise<ListenResult> {
  if (!realtimeSupported()) {
    throw new Error("Listening needs Node 22 or newer (its built-in WebSocket). This server runs on an older Node.");
  }
  const url = options.baseUrl.replace(/^http/, "ws") + "/v1/stt/live";
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${options.apiKey}` } });
  socket.binaryType = "arraybuffer";

  return new Promise<ListenResult>((resolve, reject) => {
    const result: ListenResult = {
      text: "",
      turn: null,
      speechSeconds: null,
      audioSeconds: 0,
      credits: 0,
      endedBy: "no_speech",
      connection: null,
      recorder: "",
    };
    let recording: Recording | null = null;
    let speechStartedAt: number | null = null;
    let bytesSent = 0;
    let ended = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];

    const cleanup = (): void => {
      for (const t of timers) clearTimeout(t);
      recording?.stop();
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        socket.close();
      } catch {
        // already closed
      }
      reject(err);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      result.audioSeconds = Math.max(result.audioSeconds, bytesSent / (SAMPLE_RATE * 2));
      resolve(result);
    };
    const sendEnd = (reason: ListenResult["endedBy"]): void => {
      if (ended) return;
      ended = true;
      if (result.turn === null) result.endedBy = reason;
      recording?.stop();
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "end" }));
      // The server answers end with the pending transcript and done; do not wait on it forever.
      timers.push(setTimeout(finish, 10_000));
    };

    socket.onopen = () => {
      const start: Record<string, unknown> = {
        type: "start",
        model: STT_REALTIME_MODEL,
        audio: { encoding: "pcm_s16le", sample_rate: SAMPLE_RATE },
      };
      if (options.language) start.language = options.language;
      if (options.style) start.style = options.style;
      if (options.convention) start.convention = options.convention;
      if (options.vocabulary && options.vocabulary.length > 0) start.vocabulary = options.vocabulary;
      socket.send(JSON.stringify(start));
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let message: ServerEvent;
      try {
        message = JSON.parse(event.data) as ServerEvent;
      } catch {
        return;
      }
      switch (message.type) {
        case "started": {
          result.connection = message.connection ?? null;
          recording = options.source
            ? { command: "source", audio: options.source, exited: new Promise(() => {}), stop: () => options.source?.destroy() }
            : startRecording(options.device);
          if (!recording) {
            fail(new Error(noRecorderMessage()));
            return;
          }
          result.recorder = recording.command;
          let speaking = options.isSpeaking();
          if (speaking) socket.send(JSON.stringify({ type: "playback", speaking: true }));
          const playbackPoll = setInterval(() => {
            const now = options.isSpeaking();
            if (now !== speaking && socket.readyState === WebSocket.OPEN) {
              speaking = now;
              socket.send(JSON.stringify({ type: "playback", speaking }));
            }
          }, 250);
          timers.push(playbackPoll as unknown as NodeJS.Timeout);
          recording.audio.on("data", (chunk: Buffer) => {
            if (ended || socket.readyState !== WebSocket.OPEN) return;
            for (let i = 0; i < chunk.length; i += FRAME_BYTES) {
              const frame = chunk.subarray(i, Math.min(i + FRAME_BYTES, chunk.length));
              socket.send(frame);
              bytesSent += frame.length;
            }
          });
          void recording.exited.then((stderr) => {
            // A recorder that dies before we asked it to is a failure worth reporting.
            if (!ended && !settled) fail(new Error(`The recorder (${result.recorder}) stopped: ${stderr || "no error output"}`));
          });
          timers.push(setTimeout(() => sendEnd("no_speech"), options.waitSeconds * 1000));
          timers.push(setTimeout(() => sendEnd("max_seconds"), options.maxSeconds * 1000));
          break;
        }
        case "speech_started":
          if (speechStartedAt === null) speechStartedAt = message.time ?? 0;
          break;
        case "speech_ended":
          if (speechStartedAt !== null && message.time !== undefined) result.speechSeconds = message.time - speechStartedAt;
          break;
        case "transcript":
          if (message.is_final) {
            result.text = message.text ?? "";
            result.turn = message.turn ?? 1;
            if (!ended) result.endedBy = "turn";
            if (result.speechSeconds === null && message.start !== undefined && message.end !== undefined) {
              result.speechSeconds = message.end - message.start;
            }
            // One turn is what a tool call wants; close the session.
            sendEnd("turn");
          }
          break;
        case "charged":
          if (message.total_credits !== undefined) result.credits = message.total_credits;
          break;
        case "error":
          if (message.turn !== undefined && !ended) {
            // That turn delivers no transcript; the session keeps listening, but a tool call cannot wait for another turn.
            sendEnd("no_speech");
            result.text = "";
            fail(new Error(`The transcription of this turn failed (${message.code ?? "unknown"}); the turn's audio was not billed.`));
          } else {
            fail(new Error(`Realtime transcription error: ${message.code ?? "unknown"}`));
          }
          break;
        case "done":
          if (message.total_credits !== undefined) result.credits = message.total_credits;
          if (message.total_seconds !== undefined) result.audioSeconds = message.total_seconds;
          finish();
          break;
        default:
          break;
      }
    };

    socket.onerror = () => {
      fail(new Error(`Could not keep the realtime transcription connection to ${url}.`));
    };
    socket.onclose = (event) => {
      if (settled) return;
      if (event.code === 1000) {
        finish();
        return;
      }
      const why: Record<number, string> = {
        1001: "the server is restarting; try again",
        4400: "the start frame was refused (model or audio format)",
        4401: "the API key stopped being valid",
        4402: "the account cannot cover the request floor; top up credits",
        4403: "the key's spending cap was reached",
        4408: "the connection was idle for 300 seconds",
        4413: "the client read too slowly",
        4429: "too many concurrent live connections on the account",
        4500: "internal server error",
        4502: "the transcription backend failed; try again",
        4503: "the transcription backend could not be reached; try again",
      };
      fail(new Error(`The realtime transcription connection closed (${event.code}): ${why[event.code] ?? event.reason ?? "no reason given"}.`));
    };
  });
}
