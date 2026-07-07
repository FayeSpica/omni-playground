import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

export interface Gateway {
  handle(req: IncomingMessage, res: ServerResponse): boolean
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean
  readonly target: string
}

export function createGateway(initialTarget: string): Gateway
