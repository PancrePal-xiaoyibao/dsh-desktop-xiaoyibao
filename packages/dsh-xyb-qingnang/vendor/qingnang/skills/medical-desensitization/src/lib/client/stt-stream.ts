import { getWebSocketURL } from '@/lib/client/api';

type TranscriptPayload = {
  type: 'transcript' | 'completed';
  text: string;
  isFinal?: boolean;
  logId?: string | null;
};

type ErrorPayload = {
  type: 'error';
  message: string;
  logId?: string | null;
};

type ReadyPayload = {
  type: 'ready';
};

type StartOptions = {
  language?: string;
  onTranscript?: (payload: TranscriptPayload) => void;
};

export class SttStreamClient {
  private socket: WebSocket | null = null;
  private openPromise: Promise<void> | null = null;
  private stopPromise: Promise<string> | null = null;
  private queuedChunks: ArrayBuffer[] = [];
  private finalText = '';
  private resolveStop: ((text: string) => void) | null = null;
  private rejectStop: ((error: Error) => void) | null = null;
  private onTranscript?: (payload: TranscriptPayload) => void;
  private closedByClient = false;
  private ready = false;

  async start(options: StartOptions = {}) {
    if (this.openPromise) {
      return this.openPromise;
    }

    this.onTranscript = options.onTranscript;

    this.openPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(getWebSocketURL('/api/stt/ws'));

      this.socket = socket;
      socket.binaryType = 'arraybuffer';

      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            type: 'start',
            ...(options.language ? { language: options.language } : {}),
          })
        );
      };

      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as
          | TranscriptPayload
          | ErrorPayload
          | ReadyPayload;

        if (message.type === 'ready') {
          this.ready = true;
          this.flushQueue();
          resolve();
          return;
        }

        if (message.type === 'error') {
          const error = new Error(message.message || '语音识别连接失败');
          reject(error);
          this.rejectStop?.(error);
          this.cleanupStopHandlers();
          return;
        }

        if (message.text) {
          this.finalText = message.text;
        }

        this.onTranscript?.(message);

        if (message.type === 'completed') {
          this.resolveStop?.(this.finalText);
          this.cleanupStopHandlers();
          this.close();
        }
      };

      socket.onerror = () => {
        const error = new Error('语音识别连接失败');
        reject(error);
        this.rejectStop?.(error);
        this.cleanupStopHandlers();
      };

      socket.onclose = () => {
        if (this.closedByClient) {
          return;
        }

        if (this.resolveStop) {
          if (this.finalText) {
            this.resolveStop(this.finalText);
          } else {
            this.rejectStop?.(new Error('语音识别连接已断开'));
          }
          this.cleanupStopHandlers();
        }
      };
    });

    return this.openPromise;
  }

  sendChunk(chunk: ArrayBuffer) {
    if (!chunk.byteLength) {
      return;
    }

    if (this.socket?.readyState === WebSocket.OPEN && this.ready) {
      this.socket.send(chunk);
      return;
    }

    this.queuedChunks.push(chunk);
  }

  async stop() {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    if (!this.socket || this.socket.readyState > WebSocket.OPEN) {
      return this.finalText;
    }

    this.stopPromise = new Promise<string>((resolve, reject) => {
      this.resolveStop = resolve;
      this.rejectStop = reject;

      const timeoutId = window.setTimeout(() => {
        this.cleanupStopHandlers();
        resolve(this.finalText);
        this.close();
      }, 8_000);

      const originalResolve = this.resolveStop;
      const originalReject = this.rejectStop;

      this.resolveStop = (text) => {
        window.clearTimeout(timeoutId);
        originalResolve?.(text);
      };

      this.rejectStop = (error) => {
        window.clearTimeout(timeoutId);
        originalReject?.(error);
      };

      if (this.socket?.readyState === WebSocket.OPEN) {
        this.flushQueue();
        this.socket.send(JSON.stringify({ type: 'stop' }));
      } else {
        resolve(this.finalText);
      }
    });

    return this.stopPromise;
  }

  close() {
    this.closedByClient = true;
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) {
      this.socket.close();
    }
    this.socket = null;
  }

  private flushQueue() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.ready) {
      return;
    }

    for (const chunk of this.queuedChunks) {
      this.socket.send(chunk);
    }

    this.queuedChunks = [];
  }

  private cleanupStopHandlers() {
    this.resolveStop = null;
    this.rejectStop = null;
  }
}
