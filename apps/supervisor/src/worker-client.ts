import WebSocket from "ws";
import type { WorkerActivity, WorkerEvent, WorkerRunCommand, WorkerRunResult } from "@agentslack/shared";

/** The supervisor's end of the WebSocket to the worker in an agent's laptop. */
export class WorkerClient {
  private constructor(private readonly socket: WebSocket) {}

  static connect(url: string, secret: string): Promise<WorkerClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { authorization: `Bearer ${secret}` } });
      socket.once("open", () => resolve(new WorkerClient(socket)));
      socket.once("error", reject);
    });
  }

  get open() {
    return this.socket.readyState === WebSocket.OPEN;
  }

  /** Runs one session; resolves with its result, rejects if the worker fails or the connection drops. */
  run(cmd: WorkerRunCommand, onActivity: (a: WorkerActivity) => void): Promise<WorkerRunResult> {
    return new Promise((resolve, reject) => {
      const onMessage = (raw: WebSocket.RawData) => {
        const event = JSON.parse(String(raw)) as WorkerEvent;
        if (event.type === "hello" || event.runId !== cmd.runId) return;
        if (event.type === "activity") onActivity(event.activity);
        else {
          cleanup();
          if (event.type === "done") resolve(event.result);
          else reject(new Error(event.message));
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error("connection to the laptop closed during the run"));
      };
      const cleanup = () => {
        this.socket.off("message", onMessage);
        this.socket.off("close", onClose);
      };
      this.socket.on("message", onMessage);
      this.socket.on("close", onClose);
      this.socket.send(JSON.stringify(cmd));
    });
  }

  abort(runId: string) {
    if (this.open) this.socket.send(JSON.stringify({ type: "abort", runId }));
  }

  close() {
    this.socket.close();
  }
}
