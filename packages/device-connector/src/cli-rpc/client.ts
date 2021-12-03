import { ServiceError, StatusObject } from '@grpc/grpc-js'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { ArduinoCoreServiceClient } from 'arduino-cli_proto_ts/common/cc/arduino/cli/commands/v1/ArduinoCoreService'
import { BoardListAllRequest } from 'arduino-cli_proto_ts/common/cc/arduino/cli/commands/v1/BoardListAllRequest'
import { BoardListAllResponse } from 'arduino-cli_proto_ts/common/cc/arduino/cli/commands/v1/BoardListAllResponse'
import { BoardListItem } from 'arduino-cli_proto_ts/common/cc/arduino/cli/commands/v1/BoardListItem'
import { BoardListRequest } from 'arduino-cli_proto_ts/common/cc/arduino/cli/commands/v1/BoardListRequest'
import { BoardListResponse } from 'arduino-cli_proto_ts/common/cc/arduino/cli/commands/v1/BoardListResponse'
import { BoardListWatchRequest } from 'arduino-cli_proto_ts/common/cc/arduino/cli/commands/v1/BoardListWatchRequest'
import { BurnBootloaderResponse } from 'arduino-cli_proto_ts/common/cc/arduino/cli/commands/v1/BurnBootloaderResponse'
import { CreateResponse } from 'arduino-cli_proto_ts/common/cc/arduino/cli/commands/v1/CreateResponse'
import { DetectedPort } from 'arduino-cli_proto_ts/common/cc/arduino/cli/commands/v1/DetectedPort'
import { InitRequest } from 'arduino-cli_proto_ts/common/cc/arduino/cli/commands/v1/InitRequest'
import { Instance } from 'arduino-cli_proto_ts/common/cc/arduino/cli/commands/v1/Instance'
import { MonitorRequest } from 'arduino-cli_proto_ts/common/cc/arduino/cli/commands/v1/MonitorRequest'
import { MonitorResponse } from 'arduino-cli_proto_ts/common/cc/arduino/cli/commands/v1/MonitorResponse'
import { Port } from 'arduino-cli_proto_ts/common/cc/arduino/cli/commands/v1/Port'
import { UploadResponse } from 'arduino-cli_proto_ts/common/cc/arduino/cli/commands/v1/UploadResponse'
import { ProtoGrpcType as ArduinoProtoGrpcType } from 'arduino-cli_proto_ts/common/commands'
import { BoardListWatchResponse } from 'arduino-cli_proto_ts/common/cc/arduino/cli/commands/v1/BoardListWatchResponse'
import { deleteDeviceRequest } from '../deployment-server/service'
import {
  Device,
  getAttachedDeviceOnPort,
  registerNewDevice,
  setDevices as setStoredDevices
} from '../devices/service'
import logger from '../util/logger'

export class RPCClient {
  address: string
  private client: ArduinoCoreServiceClient | undefined
  instance: Instance | undefined
  private devices: Device[] = []

  constructor (address: string = '127.0.0.1:50051') {
    this.address = address
  }

  async init (): Promise<void> {
    const loadedProto = protoLoader.loadSync('../grpc/proto/cc/arduino/cli/commands/v1/commands.proto', {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    })

    const deadline = new Date()
    deadline.setSeconds(deadline.getSeconds() + 5)

    return await new Promise((resolve, reject) => {
      const arduinoGrpcObject = grpc.loadPackageDefinition(loadedProto) as unknown as ArduinoProtoGrpcType

      const arduinoServiceClient = new arduinoGrpcObject.cc.arduino.cli.commands.v1.ArduinoCoreService(this.address, grpc.credentials.createInsecure())
      arduinoServiceClient.waitForReady(deadline, (error: Error | undefined) => {
        if (error != null) {
          return reject(new Error(error.message))
        }

        this.client = arduinoServiceClient
        logger.info(`Connected to ${this.address} (Arduino-CLI)`)
        return resolve()
      })
    })
  };

  async createInstance (): Promise<void> {
    return await new Promise((resolve, reject) => {
      if (this.client == null) {
        return reject(new Error('Client not initialized'))
      }

      this.client.Create({}, (err: ServiceError | null, data?: CreateResponse) => {
        if (err != null) {
          return reject(new Error(err.message))
        }
        if ((data == null) || (data.instance == null)) {
          return reject(new Error('No Instance created'))
        }
        this.instance = data.instance
        return resolve()
      })
    })
  }

  async destroyInstance (i?: Instance): Promise<void> {
    const instance = i ?? this.instance
    const destroyRequest = { instance }

    return await new Promise((resolve, reject) => {
      if (this.client == null) {
        return reject(new Error('Client not initialized'))
      }

      this.client.destroy(destroyRequest, (err: ServiceError | null) => {
        if (err != null) {
          return reject(new Error(err.message))
        }
        return resolve()
      })
    })
  }

  async initInstance (i?: Instance): Promise<void> {
    const instance = i ?? this.instance
    if (i != null) {
      this.instance = i
    }
    const initRequest: InitRequest = { instance }

    return await new Promise((resolve, reject) => {
      if ((instance == null) || (this.client == null)) {
        return reject(new Error('Client not connected'))
      }

      const stream = this.client.Init(initRequest)
      stream.on('status', (status: StatusObject) => {
        return status.code === 0 ? resolve() : reject(new Error(status.details))
      })

      stream.on('end', () => {
        stream.destroy()
      })

      stream.on('error', (err: Error) => {
        stream.destroy()
        return reject(new Error(err.message))
      })
    })
  }

  async listBoards (): Promise<DetectedPort[]> {
    const boardListRequest: BoardListRequest = { instance: this.instance, timeout: 1000 }

    return await new Promise((resolve, reject) => {
      if (this.client == null) {
        return reject(new Error('Client not initialized'))
      }

      this.client.boardList(boardListRequest, (err: ServiceError | null, data?: BoardListResponse) => {
        if (err != null) {
          return reject(new Error(err.message))
        }

        if ((data?.ports) == null) {
          return reject(new Error('No Boards found'))
        }

        return resolve(data.ports)
      })
    })
  }

  async listAllBoards (filter?: string[]): Promise<BoardListItem[]> {
    const boardListAllRequest: BoardListAllRequest = {
      instance: this.instance,
      search_args: filter,
      include_hidden_boards: false
    }

    return await new Promise((resolve, reject) => {
      if (this.client == null) {
        return reject(new Error('Client not initialized'))
      }
      this.client.BoardListAll(boardListAllRequest, (err: ServiceError | null, data?: BoardListAllResponse) => {
        if (err != null) {
          return reject(new Error(err.message))
        }

        if ((data?.boards) == null) {
          return reject(new Error('No Boards found'))
        }

        return resolve(data.boards)
      })
    })
  }

  async uploadBin (fqbn: string, port: Port, file: string, verify: boolean = false): Promise<boolean> {
    const uploadRequest = { instance: this.instance, fqbn, port, import_file: file, verify }

    return await new Promise((resolve, reject) => {
      if (this.client == null) {
        return reject(new Error('Client not initialized'))
      }

      const stream = this.client.Upload(uploadRequest)
      stream.on('data', (data: UploadResponse) => {
        if (data.err_stream != null && data.err_stream.length > 0) {
          reject(new Error(data.err_stream.toString()))
        }
      })
      stream.on('end', () => {
        stream.destroy()
      })

      stream.on('status', (status) => {
        return status.code === 0 ? resolve(true) : reject(new Error(status.details))
      })

      stream.on('error', (err: Error) => {
        reject(new Error(err.message))
      })
    })
  }

  async burnBootloader (fqbn: string, port: Port, programmer: string, verify: boolean = false): Promise<boolean> {
    const burnBootloaderRequest = { instance: this.instance, fqbn, port, programmer, verify }

    return await new Promise((resolve, reject) => {
      if (this.client == null) {
        return reject(new Error('Client not initialized'))
      }

      const stream = this.client.BurnBootloader(burnBootloaderRequest)
      stream.on('data', (data: BurnBootloaderResponse) => {
        if (data.err_stream != null && data.err_stream.length > 0) {
          reject(new Error(data.err_stream.toString()))
        }
      })

      stream.on('end', () => {
        stream.destroy()
      })

      stream.on('status', (status) => {
        return status.code === 0 ? resolve(true) : reject(new Error(status.details))
      })

      stream.on('error', (err: Error) => {
        reject(new Error(err.message))
      })
    })
  }

  async boardListWatch (): Promise<void> {
    const boardListWatchRequest: BoardListWatchRequest = { instance: this.instance, interrupt: false }

    if (this.client == null) {
      const error = new Error('Client not initialized')
      logger.error(error)
      return
    }

    const stream = this.client.boardListWatch()
    stream.write(boardListWatchRequest)

    stream.on('end', () => {
      stream.destroy()
    })

    stream.on('error', (err: Error) => {
      logger.error(err)
    })

    stream.on('data', (resp: BoardListWatchResponse) => {
      onNewDevice(resp).catch((err) => {
        logger.error(err)
      })
    })

    const onNewDevice = async (data: BoardListWatchResponse): Promise<void> => {
      if (data.error !== '') {
        logger.error(new Error(data.error))
      }

      const eventType = data.event_type
      const detectedPort = data.port
      const port = detectedPort?.port
      if (port == null) {
        logger.error('Port not defined')
        return
      }

      if (eventType === 'add' && detectedPort?.matching_boards != null && detectedPort.matching_boards.length > 0) {
        const board = detectedPort.matching_boards[0]
        if (board.fqbn == null) {
          logger.error('Could not register device: No fqbn found')
          return
        }

        const id = await registerNewDevice(board.fqbn, board.name ?? 'Unknown Device Name')

        const device: Device = {
          id,
          name: board.name ?? 'Unknown Device Name',
          fqbn: board.fqbn,
          port: port
        }

        this.devices.push(device)
        logger.info(`Device attached: ${device.name}`)
      } else if (eventType === 'remove') {
        if (port.address == null || port.address === '') {
          logger.warn('Removed device could not be unregistered: Unknown port')
          return
        }

        const removed = await getAttachedDeviceOnPort(port.address, port.protocol ?? 'serial')
        if (removed == null) {
          return
        }

        await this.removeDevice(removed)
      }
    }
  }

  async monitor (port: Port): Promise<grpc.ClientDuplexStream<MonitorRequest, MonitorResponse>> {
    const monitorRequest: MonitorRequest = { instance: this.instance, port }

    return await new Promise((resolve, reject) => {
      if (this.client == null) {
        return reject(new Error('Client not initialized'))
      }

      const stream = this.client.monitor()
      stream.on('end', () => {
        stream.destroy()
      })

      stream.on('error', (err: Error) => {
        logger.error(err)
      })

      stream.write(monitorRequest, (err: Error | null | undefined) => {
        if (err != null) {
          return reject(err)
        }
        return resolve(stream)
      })
    })
  }

  getDevices (): Device[] {
    return this.devices
  }

  setDevices (devices: Device[]): void {
    this.devices = devices
  }

  async removeDevice (device: Device): Promise<void> {
    const newDeviceList = this.devices.filter((deviceItem) => deviceItem !== device)
    this.setDevices(newDeviceList)
    setStoredDevices(this.devices)

    logger.info(`Device removed: ${device.name}`)
    await deleteDeviceRequest(device.id)
  }
}
