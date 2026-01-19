//  ACS580 Modbus Parameter Engine - Production Version
//  Supports: 16-bit & 32-bit Mode 0 addressing (ACS580)
//  Multi-device, per-device health, auto-reconnect, auto-recover
// ======================================================
import ModbusRTU from "modbus-serial";
import eventBus from "./event.js";

const client = new ModbusRTU();

let pollingTimer = null;
let reconnecting = false;
let isPolling = false;

// =========================
// CONFIG
// =========================
const SERIAL_PORT = "COM3";
const SERIAL_OPTS = {
  baudRate: 19200,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
};

const POLLING_INTERVAL_MS = 1000;   // loop interval
const INTER_DEVICE_DELAY_MS = 150;  // jeda antar device di RS485
const MAX_FAIL_COUNT = 3;           // gagal 3x → OFFLINE
const OFFLINE_RETRY_MS = 30000;     // coba hidupkan lagi tiap 30 detik

// =========================
// PARAMETER LIST
// =========================
const listing = [
  { name: "speed",        num: "01.01", unit: "rpm",    type: "32bit", scale: 100 },
  { name: "frequency",    num: "01.06", unit: "Hz",     type: "32bit", scale: 100 },
  { name: "current",      num: "01.07", unit: "A",      type: "32bit", scale: 100 },
  { name: "torque",       num: "01.10", unit: "%",      type: "32bit", scale: 10  },
  { name: "dc_volt",      num: "01.11", unit: "V",      type: "32bit", scale: 100 },
  { name: "output_volt",  num: "01.13", unit: "V",      type: "32bit", scale: 100 },
  { name: "motor_power",  num: "01.14", unit: "kW/hp",  type: "32bit", scale: 100 },
  { name: "mWh_counter",  num: "01.19", unit: "mWh",    type: "32bit", scale: 1   },
  { name: "kWh_counter",  num: "01.20", unit: "kWh",    type: "32bit", scale: 1   },
];

// =========================
// DEVICE LIST (per drive)
// =========================
// Tambah device lain tinggal tambah objek di sini
const devices = [
  {
    id: 1,
    name: "pmp1",
    label: "PMP 1 INTAKE",
    state: "ONLINE",        // ONLINE | OFFLINE
    failCount: 0,
    lastOk: null,
    lastError: null,
    lastProbe: 0,
  },
  {
    id: 2,
    name: "pmp2",
    label: "PMP 2 INTAKE",
    state: "ONLINE",
    failCount: 0,
    lastOk: null,
    lastError: null,
    lastProbe: 0,
  },
];

// =========================
// HELPERS: PARAM ADDRESSING
// =========================
const parseNum = (num) => {
  const [group, index] = num.split(".").map((n) => parseInt(n, 10));
  return { group, index };
};

const getAbbRegister = (group, index, type) => {
  if (type === "16bit") {
    return 400000 + 100 * group + index;
  } else if (type === "32bit") {
    return 420000 + 200 * group + 2 * index;
  }
};

const abbToNodeAddress = (abb) => {
  // ABB Mode 0 → Node.js zero-based
  return abb - 400001;
};

const getParamInfo = (param) => {
  const { group, index } = parseNum(param.num);
  const abbRegister = getAbbRegister(group, index, param.type);
  const nodeRegister = abbToNodeAddress(abbRegister);

  return {
    ...param,
    group,
    index,
    abbRegister,
    nodeRegister,
    words: param.type === "32bit" ? 2 : 1,
  };
};

// =========================
// LOW LEVEL READ
// =========================
const readParameter = async (client, param) => {
  const info = getParamInfo(param);

  const res = await client.readHoldingRegisters(info.nodeRegister, info.words);

  let buf = Buffer.from(res.buffer);
  let raw;

  if (info.type === "16bit") {
    raw = buf.readInt16LE(0);
  } else {
    // 32-bit LO-HI typical for ABB
    raw = buf.swap16().readInt32LE(0);
  }

  const value = raw / info.scale;

  return {
    name: info.name,
    num: info.num,
    unit: info.unit,
    raw,
    scale: info.scale,
    value,
  };
};

const readAllParameters = async (client) => {
  const result = [];

  for (const param of listing) {
    try {
      const res = await readParameter(client, param);
      result.push(res);
    } catch (err) {
      result.push({
        name: param.name,
        error: err.message,
      });
    }
  }

  return result;
};

// =========================
// SERIAL CONNECT / RECONNECT
// =========================
async function connect() {
  try {
    await client.connectRTUBuffered(SERIAL_PORT, SERIAL_OPTS);
    client.setTimeout(1000);

    console.log(`✅ Connected to ACS580 on ${SERIAL_PORT}`);
    return true;
  } catch (err) {
    console.error("❌ Connection error:", err.message);
    return false;
  }
}

async function ensureConnected() {
  if (client.isOpen) return true;
  if (reconnecting) return false;

  reconnecting = true;
  console.log("🔄 Attempting reconnect...");

  let ok = false;

  for (let i = 0; i < 5; i++) {
    ok = await connect();
    if (ok) break;

    console.log(`⏳ Retry ${i + 1} failed, waiting 2s...`);
    await sleep(2000);
  }

  reconnecting = false;

  if (!ok) {
    console.log("❌ Failed reconnecting after 5 attempts");
  }

  return ok;
}

// =========================
// DEVICE STATE HANDLING
// =========================
function setDeviceOnline(device) {
  if (device.state !== "ONLINE") {
    console.log(`🟢 ${device.label} (${device.name}) ONLINE`);
    eventBus.emit("acs580:device_online", { device });
  }
  device.state = "ONLINE";
  device.failCount = 0;
  device.lastOk = Date.now();
}

function setDeviceOffline(device, reason) {
  if (device.state !== "OFFLINE") {
    console.warn(`🔴 ${device.label} (${device.name}) OFFLINE: ${reason}`);
    eventBus.emit("acs580:device_offline", {
      device,
      reason,
    });
  }
  device.state = "OFFLINE";
  device.lastError = reason;
  device.lastProbe = Date.now();
}

// =========================
// POLLING ENGINE
// =========================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startPollingMultiDevice(client, intervalMs = POLLING_INTERVAL_MS) {
  if (pollingTimer) return pollingTimer;

  pollingTimer = setInterval(async () => {
    if (isPolling) {
      // Hindari overlap kalau eksekusi sebelumnya belum selesai
      return;
    }
    isPolling = true;

    try {
      const ok = await ensureConnected();
      if (!ok) {
        isPolling = false;
        return;
      }

      // opsional: flush port sebelum loop
      try {
        client._port?.flush?.();
      } catch (e) {
        // ignore
      }

      const now = Date.now();

      for (const device of devices) {
        // OFFLINE → hanya dicoba setelah OFFLINE_RETRY_MS
        if (
          device.state === "OFFLINE" &&
          now - device.lastProbe < OFFLINE_RETRY_MS
        ) {
          continue;
        }

        device.lastProbe = now;

        try {
          client.setID(device.id);

          const data = await readAllParameters(client);

          // cek kalau semua parameter error → kemungkinan bus/device mati
          const allError = data.every((d) => d.error);
          if (allError) {
            device.failCount++;
            const reason = `All parameters error (${device.failCount}x)`;
            console.warn(`⚠️ ${device.name}: ${reason}`);

            if (device.failCount >= MAX_FAIL_COUNT) {
              setDeviceOffline(device, reason);
            }
          } else {
            setDeviceOnline(device);
            // emit data only jika success
            eventBus.emit(device.name, data);
            eventBus.emit("acs580:data", {
              device,
              data,
              ts: new Date().toISOString(),
            });

            // Kalau mau log ringan:
            // console.log(`📊 ${device.name}`, data.map(d => ({ [d.name]: d.value })));
          }
        } catch (err) {
          device.failCount++;
          device.lastError = err.message;
          console.error(
            `❌ Polling error ${device.name} (${device.failCount}x):`,
            err.message
          );

          if (device.failCount >= MAX_FAIL_COUNT) {
            setDeviceOffline(device, err.message);
          }
        }

        await sleep(INTER_DEVICE_DELAY_MS);
      }
    } catch (err) {
      console.error("🔥 Polling loop fatal error:", err);
    } finally {
      isPolling = false;
    }
  }, intervalMs);

  console.log("🚀 ACS580 polling started");
  return pollingTimer;
}

// =========================
// PUBLIC API
// =========================
export async function startACS580() {
  const ok = await ensureConnected();
  if (!ok) {
    console.error("ACS580: cannot start polling, connection failed");
    return;
  }

  startPollingMultiDevice(client, POLLING_INTERVAL_MS);
}
