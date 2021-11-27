import { env } from 'process'
import { createApp } from './util/app'

import type { Server } from 'node:http'
import logger from './util/logger'
import connect from './util/prisma'
import { PrismaClient } from '@prisma/client'
import { Application } from 'express'
import { QueueManager, stop } from './connectors/queue'
import { Signals } from 'close-with-grace'
import { promisify } from 'util'

export async function createServer (): Promise<[Server, Application, PrismaClient]> {
  try {
    const db = await connect()
    const app = createApp(db)
    const server = app.listen(env.PORT)
    QueueManager.setServer(server)
    await QueueManager.start()
    return [server, app, db]
  } catch (e) {
    logger.error(e)
    throw e
  }
}

export async function closeServer (
  this: {server: Server, db: PrismaClient},
  { err, signal }: { err?: Error, signal?: Signals | string } = { }
): Promise<void> {
  if (err != null) {
    logger.error(err)
  }

  logger.info(`${signal ?? 'Manual Exit'}: Closing server`)
  await this.db.$disconnect()

  await stop()

  await promisify(this.server.close)()
}
