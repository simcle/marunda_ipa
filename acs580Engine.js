// ======================================================
// ACS580 Modbus Parameter Engine (Industrial Version)
// 1 Port RS485 - Multi Slave
// Self-timed polling + slave isolation + auto reconnect
// ======================================================

import ModbusRTU from "modbus-serial";
import eventBus from "./event.js";

const client = new ModbusRTU();

// =========================
// GLOBAL STATE
// =========================
let reconnecting = false;
let pollingStarted = false;

// =========================
// DEVICE LIST (MULTI SLAVE)
// =========================
const deviceList = [
    { id: 1, name: 'pmp1', failCount: 0, disabledUntil: 0 },
    { id: 2, name: 'pmp2', failCount: 0, disabledUntil: 0 },
];

// =========================
// PARAMETER LIST
// =========================
const listing = [
    { name: 'speed',         num: '01.01', unit: 'rpm', type: '32bit', scale: 100 },
    { name: 'frequency',     num: '01.06', unit: 'Hz',  type: '32bit', scale: 100 },
    { name: 'current',       num: '01.07', unit: 'A',   type: '32bit', scale: 100 },
    { name: 'torque',        num: '01.10', unit: '%',   type: '32bit', scale: 10  },
    { name: 'dc_volt',       num: '01.11', unit: 'V',   type: '32bit', scale: 100 },
    { name: 'output_volt',   num: '01.13', unit: 'V',   type: '32bit', scale: 1   },
    { name: 'motor_power',   num: '01.14', unit: 'kW',  type: '32bit', scale: 100 },
    { name: 'mWh_counter',   num: '01.19', unit: 'mWh', type: '32bit', scale: 1   },
    { name: 'kWh_counter',   num: '01.20', unit: 'kWh', type: '32bit', scale: 1   },
    { name: 'running_time',  num: '05.03', unit: 'h',   type: '32bit', scale: 10  },
];

// ======================================================
// HELPER FUNCTIONS
// ======================================================
const sleep = ms => new Promise(r => setTimeout(r, ms));

const parseNum = (num) => {
    const [group, index] = num.split(".").map(n => parseInt(n, 10));
    return { group, index };
};

const getAbbRegister = (group, index, type) => {
    if (type === '16bit') return 400000 + (100 * group) + index;
    if (type === '32bit') return 420000 + (200 * group) + (2 * index);
};

const abbToNodeAddress = (abb) => abb - 400001;

const getParamInfo = (param) => {
    const { group, index } = parseNum(param.num);
    const abbRegister = getAbbRegister(group, index, param.type);
    const nodeRegister = abbToNodeAddress(abbRegister);

    return {
        ...param,
        abbRegister,
        nodeRegister,
        words: param.type === '32bit' ? 2 : 1,
    };
};

// =========================
// ERROR CLASSIFICATION
// =========================
const isPortError = (err) => {
    return (
        err.message?.includes('Port Not Open') ||
        err.code === 'EIO' ||
        err.code === 'ENODEV' ||
        err.code === 'EBADF'
    );
};

// ======================================================
// READ SINGLE PARAMETER
// ======================================================
const readParameter = async (param) => {
    const info = getParamInfo(param);
    const res = await client.readHoldingRegisters(info.nodeRegister, info.words);

    const buf = Buffer.from(res.buffer);
    let raw;

    if (info.type === "16bit") {
        raw = buf.readInt16LE(0);
    } else {
        raw = buf.swap16().readInt32LE(0); // ABB LO-HI
    }

    return {
        name: info.name,
        num: info.num,
        unit: info.unit,
        raw,
        scale: info.scale,
        value: raw / info.scale,
    };
};

// ======================================================
// READ ALL PARAMETERS (SEQUENTIAL)
// ======================================================
const readAllParameters = async () => {
    const result = [];
    for (const param of listing) {
        try {
            result.push(await readParameter(param));
        } catch (err) {
            result.push({ name: param.name, error: err.message });
        }
    }
    return result;
};

// ======================================================
// CONNECTION HANDLING
// ======================================================
async function connect() {
    try {
        await client.connectRTUBuffered("/dev/ttyUSB0", {
            baudRate: 19200,
            dataBits: 8,
            stopBits: 1,
            parity: "none",
        });

        client.setTimeout(500);
        console.log("✅ RS485 Connected");
        return true;

    } catch (err) {
        console.error("❌ Connect error:", err.message);
        return false;
    }
}

async function ensureConnected() {
    if (client.isOpen) return true;
    if (reconnecting) return false;

    reconnecting = true;
    console.log("🔄 Reconnecting RS485...");

    let ok = false;
    for (let i = 0; i < 5; i++) {
        ok = await connect();
        if (ok) break;
        await sleep(2000);
    }

    reconnecting = false;
    return ok;
}


// ======================================================
// PRE-CHECK SLAVE (FAST PROBE)
// ======================================================
const precheckParam = {
    name: 'frequency',
    num: '01.06',
    unit: 'Hz',
    type: '32bit',
    scale: 100
};

async function precheckSlave() {
    // 1 request ringan saja
    await readParameter(precheckParam);
}


// ======================================================
// POLLING LOOP (SELF-TIMED)
// ======================================================
async function pollingLoop(intervalMs = 1000) {
    const start = Date.now();

    try {
        if (!client.isOpen) {
            await ensureConnected();
        }

        if (!client.isOpen) {
            scheduleNext(start, intervalMs);
            return;
        }

        for (const device of deviceList) {

            if (Date.now() < device.disabledUntil) continue;

            try {
                client.setID(device.id);
                await precheckSlave()
                const data = await readAllParameters();
                eventBus.emit(device.name, data);
                
                device.failCount = 0;

            } catch (err) {

                if (isPortError(err)) {
                    console.error("🔥 PORT ERROR:", err.message);
                    try { client.close(); } catch {}
                    break;
                }

                device.failCount++;
                console.warn(`⚠️ ${device.name} fail ${device.failCount}`);

                if (device.failCount >= 3) {
                    device.disabledUntil = Date.now() + 5000;
                    console.warn(`⏸ ${device.name} cooldown 5s`);
                }
            }

            await sleep(100);
        }

    } catch (err) {
        console.error("🔥 Unexpected polling error:", err.message);
        try { client.close(); } catch {}
    }

    scheduleNext(start, intervalMs);
}

// ======================================================
// SCHEDULER
// ======================================================
function scheduleNext(start, intervalMs) {
    const elapsed = Date.now() - start;
    const delay = Math.max(0, intervalMs - elapsed);
    setTimeout(() => pollingLoop(intervalMs), delay);
}

// ======================================================
// PUBLIC START FUNCTION
// ======================================================
export async function startACS580() {
    if (pollingStarted) return;
    pollingStarted = true;

    const ok = await ensureConnected();
    if (!ok) return;

    pollingLoop(1000);
}