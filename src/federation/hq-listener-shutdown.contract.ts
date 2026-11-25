import { WebSocket } from "ws";

export default {
  post(result: unknown, closing: boolean, readyState: number): boolean {
    return result === (!closing && readyState === WebSocket.OPEN);
  },
};
