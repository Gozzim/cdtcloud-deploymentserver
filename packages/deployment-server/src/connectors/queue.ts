import type { Device } from '@prisma/client'
import * as WebSocket from 'ws'
import type { AddressInfo, Server as WSServer } from 'ws'
import { promisify } from 'node:util'
import type { Server } from 'node:http'
import { db } from '../util/prisma'

const WebSocketServer = ((WebSocket as any).WebSocketServer) as typeof WSServer

type ConnectorId = string

export const QueueManager = {
  queueMap: new Map<ConnectorId, WSServer>(),
  server: null as Server | null,

  setServer (server: Server) {
    this.server = server
  },

  register (uuid: ConnectorId): WSServer {
    if (this.server == null) {
      throw new Error('Server not set')
    }

    const wsServer = new WebSocketServer({ server: this.server, path: `/connectors/${uuid}/queue` })
    this.queueMap.set(uuid, wsServer)

    wsServer.on('error', () => {
      this.queueMap.delete(uuid)
    })

    return wsServer
  },

  has (uuid: ConnectorId): boolean {
    return this.queueMap.has(uuid)
  },

  get (uuid: ConnectorId): WSServer | null {
    return this.queueMap.get(uuid) ?? null
  },

  remove (uuid: ConnectorId): boolean {
    const wsServer = this.queueMap.get(uuid)
    if (wsServer != null) {
      wsServer.close()
    }
    return this.queueMap.delete(uuid)
  },

  async stop () {
    const teardownResult = await Promise.allSettled([...this.queueMap].map(async ([_, wsServer]) => {
      return await promisify(wsServer.close)()
    }))

    const errors = teardownResult.filter(({ status }) => status === 'rejected') as PromiseRejectedResult[]

    if (errors.length > 0) {
      throw new AggregateError(errors.map(({ reason }) => reason))
    }
  },

  // Reconnects all the queues
  async start (): Promise<WSServer[]> {
    const connectors = await db.connector.findMany()

    return connectors.map(({ id }) => this.register(id))
  }
}

export function registerConnector ({ id: connectorId }: {id: ConnectorId}): WSServer {
  return QueueManager.register(connectorId)
}

export function unregisterConnector ({ id: connectorId }: {id: ConnectorId}): void {
  QueueManager.remove(connectorId)
}

export function getServerForConnector ({ id: connectorId }: {id: ConnectorId}): WSServer | null {
  return QueueManager.get(connectorId)
}

export function getPortForConnector ({ id: connectorId }: {id: ConnectorId}): number | null {
  return (QueueManager.get(connectorId)?.address() as AddressInfo | undefined)?.port ?? null
}

export async function stop (): Promise<void> {
  return await QueueManager.stop()
}

export async function addDeployRequest (connectorId: ConnectorId, device: Device, artifactUri: string): Promise<void> {
  return await new Promise((resolve, reject) => {
    const queue = QueueManager.get(connectorId)

    if (queue == null) {
      return reject(new Error('Queue not found'))
    } else {
      queue.clients
        .forEach(client => {
          if (client.readyState !== WebSocket.OPEN) {
            return
          }

          client.send(JSON.stringify({
            type: 'deploy',
            data: {
              deviceType: device,
              artifactUri
            }
          }), (err) => {
            if (err != null) {
              return reject(err)
            } else {
              return resolve()
            }
          })
        })
    }
  })
}
