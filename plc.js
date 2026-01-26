import ModbusRTU from "modbus-serial";
import eventBus from "./event.js";

const client = new ModbusRTU()

const PLC_HOST = '192.168.88.221'
const PLC_PORT = 502
const POLLING_ITERVAL = 1000
const RECONNECT_DELAY = 3000


const tags = [
    {name: 'ft_4001', offset: 0},
    {name: 'ft_8001', offset: 2},
    {name: 'nit_4001', offset: 4},
    {name: 'nit_8001', offset: 6},
    {name: 'ph_4001', offset: 8},
    {name: 'ph_8001', offset: 10},
    {name: 'chl_8001', offset: 12},
    {name: 'lit_4001', offset: 14},
    {name: 'lit_4002', offset: 16},
    {name: 'lit_7001', offset: 18},
    {name: 'lit_7002', offset: 20},
    {name: 'lit_7003', offset: 22},
    {name: 'lit_7004', offset: 24},
    {name: 'lit_7005', offset: 26},
    {name: 'lit_7006', offset: 28},
    {name: 'lit_8001', offset: 30},
    {name: 'lit_8002', offset: 32},
]

const readFloat = (data, offset) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt16BE(data[offset], 0);
  buffer.writeUInt16BE(data[offset + 1], 2);
  return buffer.readFloatBE(0);
};

let isConnected = false
const connectPlc = async () => {
    try {
        await client.connectTCP(PLC_HOST, {port: PLC_PORT})
        client.setID(1)
        isConnected = true
    } catch (error) {
        isConnected = false
    }
}

const pollData = async () => {
    if(!isConnected) return
    try {
        const message = {}
        const test = await client.readHoldingRegisters(48, 2)
        const word = test.data[0];
        console.log(word)
        // Extract bit
        
        
        // message['blo_7001'] = bit1
        // message['pmp_7001'] = bit2

        const regs = await client.readHoldingRegisters(1305, 4)
        message['fqt_4001'] = regs.buffer.readInt32BE(0)
        message['fqt_8001'] = regs.buffer.readInt32BE(4)
        const res = await client.readHoldingRegisters(1003, 34)
        const data = res.data
        tags.forEach(tag => {
            const value = readFloat(data, tag.offset)
            message[tag.name] = value.toFixed(2)
        })
        eventBus.emit('plc', message)
    } catch (error) {
        console.log(error)
        isConnected = false
        try {
            client.close()
        } catch (error) {
            console.log('error')   
        }
        setTimeout(connectPlc, RECONNECT_DELAY)
    }
}

const startPollingPlc = async () => {
    await connectPlc()
    setInterval(async () => {
        await pollData()
    }, POLLING_ITERVAL)
}

export default startPollingPlc