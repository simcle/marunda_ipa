import mqtt from "mqtt";
import startPollingPlc from "./plc.js";
import { startACS580} from "./acs580-01.js";
import { startTcpServer, holdingRegisters } from "./tcpServer.js";
import eventBus from "./event.js";

let mqttClient = null
let mqttIsConnected = false
mqttClient = mqtt.connect('mqtt://mqtt.ndpteknologi.com', {
    clientId: 'marunda_ipa' + Math.random().toString(16).slice(2, 8),
    reconnectPeriod: 3000
})

mqttClient.on('connect', () => {
    console.log('MQTT is connected')
    mqttIsConnected = true
})

mqttClient.on('close', () => {
    mqttIsConnected = false
})

mqttClient.on('error', () => {
    mqttIsConnected = false
})


const pmp1RegisterMap = {
    speed: { reg: 8403, },
    frequency: { reg: 8405},
    current: { reg: 8407},
    torque: {reg: 8409},
    motor_power: {reg: 8411},
    dc_volt: {reg: 8415},
    kWh_counter: {reg: 8427},
    mWh_counter: {reg: 8431}
}
const pmp2RegisterMap = {
    speed: { reg: 8503, },
    frequency: { reg: 8505},
    current: { reg: 8507},
    torque: {reg: 8509},
    motor_power: {reg: 8511},
    dc_volt: {reg: 8515},
    kWh_counter: {reg: 8527},
    mWh_counter: {reg: 8531}
}

function writeInt32ToHR(hrAddr, rawValue) {
    const reg0 = hrAddr
    const offset = reg0 * 2; // register → byte
    holdingRegisters.writeFloatBE(rawValue, offset);
}

const data = {
    plc: '',
    pmp1: {},
    pmp2: {}
}

eventBus.on('plc', (val) => {
    data.plc = val
})


eventBus.on('pmp1', (val) => {
    val.forEach(p => {
        data.pmp1[p.name] = p.value
        
        // save to modbus TCP
        const map = pmp1RegisterMap[p.name]
        if(!map) return
        console.log(p.value)
        writeInt32ToHR(map.reg, p.value)
    })
})

eventBus.on('pmp2', (val) => {
    val.forEach(p => {
        data.pmp2[p.name] = p.value
        
        // save to modbus TCP
        const map = pmp2RegisterMap[p.name]
        if(!map) return
        console.log(p.value)
        writeInt32ToHR(map.reg, p.value)
    })
})

async function start() {
    await startTcpServer()

    setInterval(() => {
        mqttClient.publish('marunda/ipa', JSON.stringify(data))
    }, 1000)

    startPollingPlc()
    startACS580()
}

start()